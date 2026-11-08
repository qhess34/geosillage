import time

from fastapi.testclient import TestClient

from app import db, main
from app.exif import reader

from .conftest import tree_hash


def wait_jobs(client, pid, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        jobs = client.get(f"/api/projects/{pid}/jobs").json()
        if jobs and all(j["state"] != "running" for j in jobs):
            return jobs
        time.sleep(0.1)
    raise TimeoutError(jobs)


def test_reader_on_gopro_like_file(samples):
    m = reader.read_batch([str(samples / "100GOPRO" / "GSAC0010.JPG")])[0]
    assert m.error is None
    assert (m.make, m.model, m.projection, m.is_360) == ("GoPro", "GoPro Max", "equirectangular", True)
    assert m.width == 512 and m.height == 256
    assert 43.5 < m.lat < 43.7 and 3.8 < m.lon < 3.95
    assert m.ts is not None and m.gps_ts is not None
    assert m.heading is None


def test_reader_reports_unreadable(tmp_path):
    bad = tmp_path / "x.jpg"
    bad.write_bytes(b"not a jpeg")
    m = reader.read_batch([str(bad)])[0]
    assert m.error or not m.width


def test_full_import_and_persistence(samples):
    before = tree_hash(samples)
    with TestClient(main.app) as client:
        pid = client.post("/api/projects", json={"name": "Sortie test"}).json()["id"]
        r = client.post(f"/api/projects/{pid}/import", json={"paths": [str(samples)]})
        assert r.status_code == 202
        wait_jobs(client, pid)
        s = client.get(f"/api/projects/{pid}").json()["summary"]

        assert s["total"] == 122  # 120 + duplicate + corrupted
        assert s["duplicates"] == 1
        assert s["no_gps"] == 3
        assert s["no_date"] == 1
        assert s["interruptions"] >= 1
        assert s["unreadable"] == 1  # truncated JPEG, detected by the thumbnail decoder
        assert s["thumbs_done"] == 121 and s["thumbs_failed"] == 1
        assert s["geolocated"] == 119
        assert s["distance_m"] > 500
        assert s["duration_s"] > 240

        photos = client.get(f"/api/projects/{pid}/photos").json()
        assert len(photos["rows"]) == 122
        idx = [r[photos["fields"].index("idx")] for r in photos["rows"]]
        assert idx == sorted(idx)
        first = photos["rows"][5][0]
        assert client.get(f"/api/projects/{pid}/photos/{first}/thumb").status_code == 200
        assert client.get(f"/api/projects/{pid}/photos/{first}").json()["is_360"] == 1

        # Re-import: nothing new
        client.post(f"/api/projects/{pid}/import", json={"paths": [str(samples)]})
        wait_jobs(client, pid)
        assert client.get(f"/api/projects/{pid}").json()["summary"]["total"] == 122

    # "Restart": a new app instance finds the same project and data
    with TestClient(main.app) as client:
        projects = client.get("/api/projects").json()
        assert [p["id"] for p in projects] == [pid]
        assert projects[0]["photo_count"] == 122

    assert tree_hash(samples) == before, "source photos must never be modified"


def test_missing_files_and_delete(samples, tmp_path):
    import shutil

    src = tmp_path / "copy"
    shutil.copytree(samples / "101GOPRO", src)
    with TestClient(main.app) as client:
        pid = client.post("/api/projects", json={"name": "p"}).json()["id"]
        client.post(f"/api/projects/{pid}/import", json={"paths": [str(src)]})
        wait_jobs(client, pid)
        victim = sorted(src.iterdir())[0]
        victim.unlink()
        client.post(f"/api/projects/{pid}/check-files")
        wait_jobs(client, pid)
        assert client.get(f"/api/projects/{pid}").json()["summary"]["missing_files"] == 1

        assert client.delete(f"/api/projects/{pid}").status_code == 204
        assert client.get(f"/api/projects/{pid}").status_code == 404
        assert not db.project_dir(pid).exists()
    assert len(list(src.iterdir())) > 0  # sources untouched by project deletion


def test_bad_ids_are_rejected():
    import pytest

    for bad in ("../etc", "..", "ABC", "", "a/b"):
        with pytest.raises(db.ProjectNotFound):
            db.project_dir(bad)
    with TestClient(main.app) as client:
        assert client.get("/api/projects/zzz").status_code == 404
        assert client.get("/api/projects/%2e%2e%2f%2e%2e").status_code == 404


def test_static_files_stay_inside_dist():
    from app import config

    if not config.FRONTEND_DIST.exists():
        return
    with TestClient(main.app) as client:
        r = client.get("/..%2f..%2fbackend%2fapp%2fconfig.py")
        assert "DATA_DIR" not in r.text


def test_fs_list_subfolders(tmp_path):
    root = tmp_path / "carte"
    root.mkdir()
    # folder picker: sub-folders listed (special names, links to folders), broken links skipped, JPEGs counted
    (root / "100GOPRO").mkdir()
    (root / "a#b & é").mkdir()
    (root / "x.JPG").write_bytes(b"")
    (root / "lien").symlink_to(root / "100GOPRO")
    (root / "casse").symlink_to(root / "absent")
    with TestClient(main.app) as client:
        r = client.get("/api/fs", params={"path": str(root)}).json()
        assert r["dirs"] == ["100GOPRO", "a#b & é", "lien"] and r["jpeg_count"] == 1
        assert r["files"] == [{"name": "x.JPG", "size": 0}]
        sub = client.get("/api/fs", params={"path": f"{root}/a#b & é"}).json()
        assert sub["path"] == str(root / "a#b & é") and sub["parent"] == str(root)
        assert client.get("/api/fs", params={"path": str(root / "absent")}).status_code == 400


def test_ensure_dirs_concurrent():
    # parallel requests used to remove each other's write probe (FileNotFoundError, HTTP 500)
    from concurrent.futures import ThreadPoolExecutor

    from app import config

    with ThreadPoolExecutor(8) as ex:
        list(ex.map(lambda _: config.ensure_dirs(), range(200)))
    assert not list(config.PROJECTS_DIR.glob(".write-test*"))
