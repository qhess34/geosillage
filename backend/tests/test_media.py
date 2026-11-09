"""Type of the pictures of a project (360° or flat): detection, one type per project, confirmation of 2:1 images."""

from fastapi.testclient import TestClient
from PIL import Image

from app import db, main
from app.exif import reader

from .test_import import wait_jobs


def _import(client, pid, path, **extra):
    return client.post(f"/api/projects/{pid}/import", json={"paths": [str(path)], **extra})


def test_reader_flat_and_360(flat_samples, samples):
    f = reader.read_batch([str(next((flat_samples / "100GOPRO").glob("*.JPG")))])[0]
    assert (f.is_360, f.maybe_360, f.projection) == (False, False, None)
    assert f.heading is not None  # GPSImgDirection of the compass
    g = reader.read_batch([str(samples / "100GOPRO" / "GSAC0010.JPG")])[0]
    assert g.is_360 and (g.pitch, g.roll) == (0.0, 0.0)


def test_flat_project_and_refusals(flat_samples, samples):
    with TestClient(main.app) as client:
        pid = client.post("/api/projects", json={"name": "Plat"}).json()["id"]
        assert client.get(f"/api/projects/{pid}").json()["media"] is None
        assert _import(client, pid, flat_samples).status_code == 202
        wait_jobs(client, pid)
        p = client.get(f"/api/projects/{pid}").json()
        assert p["media"] == "flat" and p["summary"]["is_360"] == 0
        assert 1.5 < p["summary"]["median_interval_s"] < 2.5 and not p["summary"]["interval_warning"]
        # another type: refused with a clear message (French, then English)
        r = _import(client, pid, samples)
        assert r.status_code == 409 and "photos plates" in r.json()["detail"] and "360°" in r.json()["detail"]
        r = client.post(f"/api/projects/{pid}/import/check", json={"paths": [str(samples)]}, headers={"Accept-Language": "en"})
        assert r.status_code == 409 and "flat pictures" in r.json()["detail"]


def test_360_project_and_mixed_selection(samples, flat_samples, tmp_path):
    mix = tmp_path / "mix"
    mix.mkdir()
    for src in (next((samples / "100GOPRO").glob("*.JPG")), next((flat_samples / "100GOPRO").glob("*.JPG"))):
        (mix / src.name).write_bytes(src.read_bytes())
    with TestClient(main.app) as client:
        pid = client.post("/api/projects", json={"name": "360"}).json()["id"]
        r = _import(client, pid, mix)
        assert r.status_code == 409 and "mélange" in r.json()["detail"]
        assert _import(client, pid, samples).status_code == 202
        wait_jobs(client, pid)
        assert client.get(f"/api/projects/{pid}").json()["media"] == "360"
        r = _import(client, pid, flat_samples)
        assert r.status_code == 409
        with db.open_project(pid) as conn:  # pose of the file is stored (read only)
            assert conn.execute("SELECT COUNT(*) FROM photo WHERE pitch_orig = 0 AND roll_orig = 0").fetchone()[0] > 100


def test_2_1_without_xmp_needs_confirmation(tmp_path):
    d = tmp_path / "p"
    d.mkdir()
    Image.new("RGB", (64, 32)).save(d / "a.jpg")
    with TestClient(main.app) as client:
        pid = client.post("/api/projects", json={"name": "2:1"}).json()["id"]
        assert client.post(f"/api/projects/{pid}/import/check", json={"paths": [str(d)]}).json() == {"media": "flat", "ask": True}
        assert _import(client, pid, d).status_code == 409
        r = _import(client, pid, d, media="360")
        assert r.status_code == 202
        wait_jobs(client, pid)
        p = client.get(f"/api/projects/{pid}").json()
        assert p["media"] == "360" and p["summary"]["is_360"] == 1


def test_migration_gives_existing_projects_their_type(tmp_path):
    conn = db._connect(tmp_path / "old.sqlite")
    for i in range(len(db.MIGRATIONS) - 1):
        conn.executescript("BEGIN;" + db.MIGRATIONS[i] + f"; PRAGMA user_version={i + 1}; COMMIT;")
    conn.execute("INSERT INTO photo(path, filename, size, mtime, is_360) VALUES('a', 'a', 0, 0, 1)")
    db.migrate(conn)
    assert db.get_meta(conn, "media") == "360"
