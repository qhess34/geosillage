import hashlib
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import main
from app.exif import reader

from .conftest import tree_hash
from .test_import import wait_jobs


def scan_hash(path: Path) -> str:
    """Hash of the JPEG entropy-coded data (from the first SOS marker): unchanged if no re-encoding."""
    data = path.read_bytes()
    return hashlib.sha256(data[data.index(b"\xff\xda") :]).hexdigest()


@pytest.fixture()
def project(samples):
    with TestClient(main.app) as client:
        pid = client.post("/api/projects", json={"name": "Export"}).json()["id"]
        client.post(f"/api/projects/{pid}/import", json={"paths": [str(samples)]})
        wait_jobs(client, pid)
        yield client, pid


def test_sequences_undo_redo(project):
    client, pid = project
    props = client.get(f"/api/projects/{pid}/sequences/proposals").json()
    # The ride has one 4-minute interruption: two proposed segments, cut at the gap
    assert len(props) == 2, props
    assert "interruption" in props[1]["reason"]
    r = client.post(f"/api/projects/{pid}/sequences/bulk", json={"segments": [[p["start_idx"], p["end_idx"]] for p in props]})
    seqs = r.json()["sequences"]
    assert len(seqs) == 2 and sum(s["count"] for s in seqs) == 116  # 122 - dup - corrupted - 3 no GPS - 1 no date
    assert r.json()["undo"]["undo"].startswith("Création")

    # Overlap is refused
    assert client.post(f"/api/projects/{pid}/sequences", json={"start_idx": 10, "end_idx": 20}).status_code == 409

    a, b = seqs
    photos = client.get(f"/api/projects/{pid}/photos").json()
    f = photos["fields"]
    in_a = [row for row in photos["rows"] if row[f.index("sequence_id")] == a["id"]]
    cut = in_a[20][0]
    s = client.post(f"/api/projects/{pid}/sequences/{a['id']}/split", params={"photo_id": cut}).json()
    assert [x["count"] for x in s["sequences"]] == [20, a["count"] - 20, b["count"]]
    # Non-adjacent merge refused (the new middle sequence lies between a and b)
    assert client.post(f"/api/projects/{pid}/sequences/merge", json={"ids": [a["id"], b["id"]]}).status_code == 409
    s = client.post(f"/api/projects/{pid}/sequences/merge", json={"ids": [a["id"], s["new_id"]]}).json()
    assert [x["count"] for x in s["sequences"]] == [a["count"], b["count"]]
    client.patch(f"/api/projects/{pid}/sequences/{a['id']}", json={"name": "Matin"})

    u = client.post(f"/api/projects/{pid}/undo").json()  # rename
    assert u["done"] == "Renommage de séquence" and u["sequences"][0]["name"] == a["name"]
    client.post(f"/api/projects/{pid}/undo")  # merge
    u = client.post(f"/api/projects/{pid}/undo").json()  # split
    assert len(u["sequences"]) == 2
    r = client.post(f"/api/projects/{pid}/redo").json()
    assert r["done"] == "Division de séquence" and len(r["sequences"]) == 3

    d = client.delete(f"/api/projects/{pid}/sequences/{a['id']}").json()
    assert len(d["sequences"]) == 2
    assert client.post(f"/api/projects/{pid}/undo").json()["done"] == "Suppression de séquence"


def test_headings_manual_range_and_offset(project):
    client, pid = project
    props = client.get(f"/api/projects/{pid}/sequences/proposals").json()
    seqs = client.post(f"/api/projects/{pid}/sequences/bulk", json={"segments": [[p["start_idx"], p["end_idx"]] for p in props]}).json()["sequences"]
    h = seqs[0]["headings"]
    assert h["total"] == seqs[0]["count"] and h["computed"] >= h["total"] - 2 and h["manual"] == 0

    photos = client.get(f"/api/projects/{pid}/photos").json()
    f = photos["fields"]
    row = next(r for r in photos["rows"] if r[f.index("sequence_id")] == seqs[0]["id"] and r[f.index("heading")] is not None)
    pid_photo, auto = row[0], row[f.index("heading")]

    client.patch(f"/api/projects/{pid}/sequences/{seqs[0]['id']}", json={"heading_offset": 12})
    d = client.get(f"/api/projects/{pid}/photos/{pid_photo}").json()
    assert d["heading_final"] == pytest.approx((auto + 12) % 360, abs=0.01)

    client.put(f"/api/projects/{pid}/photos/{pid_photo}/heading", json={"value": 359.5})
    d = client.get(f"/api/projects/{pid}/photos/{pid_photo}").json()
    assert d["heading_final"] == 359.5 and d["heading_auto"] == pytest.approx(auto)

    # Recompute never overwrites the manual heading
    client.post(f"/api/projects/{pid}/headings/recompute")
    assert client.get(f"/api/projects/{pid}/photos/{pid_photo}").json()["heading_final"] == 359.5

    idx = row[f.index("idx")]
    r = client.post(f"/api/projects/{pid}/headings/range", json={"start_idx": idx, "end_idx": idx + 4, "mode": "offset", "value": 15}).json()
    assert r["changed"] == 5
    assert client.get(f"/api/projects/{pid}/photos/{pid_photo}").json()["heading_final"] == pytest.approx(14.5)
    client.post(f"/api/projects/{pid}/undo")
    assert client.get(f"/api/projects/{pid}/photos/{pid_photo}").json()["heading_final"] == 359.5
    client.post(f"/api/projects/{pid}/headings/range", json={"start_idx": idx, "end_idx": idx + 4, "mode": "clear"})
    assert client.get(f"/api/projects/{pid}/photos/{pid_photo}").json()["heading_manual"] is None


def test_export_folders_and_exif(project, samples, tmp_path):
    client, pid = project
    before = tree_hash(samples)
    props = client.get(f"/api/projects/{pid}/sequences/proposals").json()
    seqs = client.post(f"/api/projects/{pid}/sequences/bulk", json={"segments": [[p["start_idx"], p["end_idx"]] for p in props]}).json()["sequences"]
    client.patch(f"/api/projects/{pid}/sequences/{seqs[0]['id']}", json={"name": "Matin à vélo"})
    client.patch(f"/api/projects/{pid}/sequences/{seqs[1]['id']}", json={"heading_offset": -8})

    # Manual heading 0.2° and a corrected position on one photo
    photos = client.get(f"/api/projects/{pid}/photos").json()
    f = photos["fields"]
    first = next(r for r in photos["rows"] if r[f.index("sequence_id")] == seqs[0]["id"])
    client.put(f"/api/projects/{pid}/photos/{first[0]}/heading", json={"value": 0.2})
    from app import db

    with db.open_project(pid) as conn:
        conn.execute("UPDATE photo SET lat=43.61, lon=3.871, pos_method='manual' WHERE id=?", (first[0],))

    # Export into a source folder is refused
    assert client.post(f"/api/projects/{pid}/export", json={"out_dir": str(samples / "out")}).status_code == 400

    out = tmp_path / "export"
    r = client.post(f"/api/projects/{pid}/export", json={"out_dir": str(out)})
    assert r.status_code == 202
    jobs = wait_jobs(client, pid)
    assert jobs[0]["kind"] == "export" and jobs[0]["state"] == "done", jobs[0]

    dirs = sorted(p.name for p in out.iterdir())
    assert dirs == ["Export_1", "Export_2"]  # <project name>_<n>
    from app import db as _db

    with _db.open_project(pid) as conn:
        jumps = dict(conn.execute("SELECT sequence_id, COUNT(*) FROM photo WHERE flags & ? AND lat IS NULL GROUP BY sequence_id", (_db.GPS_JUMP,)).fetchall())
    assert sum(jumps.values()) >= 1  # the simulated ride has GPS jumps: they are left out by default
    for d, s in zip(dirs, seqs):
        jpgs = sorted((out / d).glob("*.JPG"))
        assert len(jpgs) == s["count"] - jumps.get(s["id"], 0)
        marker = json.loads((out / d / ".pss-export.json").read_text())
        assert len(marker["report"]["excluded_gps_jumps"]) == jumps.get(s["id"], 0)
        assert (out / d / "photos.csv").exists() and (out / d / ".pss-export.json").exists()
    files = sorted((out / dirs[0]).glob("*.JPG"))
    assert files[0].name.startswith("0001_GSAC")

    # Tags written, image data untouched, other metadata preserved
    metas = {Path(m.path).name: m for m in reader.read_batch([str(p) for p in files])}
    m0 = metas[files[0].name]
    assert m0.heading == pytest.approx(0.6)  # Panoramax rule for headings rounding to 0
    assert (m0.lat, m0.lon) == (pytest.approx(43.61), pytest.approx(3.871))
    assert sum(m.heading is not None for m in metas.values()) >= len(files) - 2
    assert m0.make == "GoPro" and m0.model == "GoPro Max" and m0.projection == "equirectangular" and m0.is_360
    tags = reader.dump_all(str(files[0]))
    assert tags["GPS:GPSImgDirectionRef"] == "True North"
    # PoseHeadingDegrees is the yaw for Panoramax: the camera's 0.0 is kept (heading only in GPSImgDirection)
    assert tags["XMP-GPano:PoseHeadingDegrees"] == pytest.approx(0.0)
    assert tags["GPS:GPSVersionID"] == "2.3.0.0"
    assert "GPS:GPSSpeed" not in tags  # the manual position makes an implausible speed: not written
    t5 = reader.dump_all(str(files[5]))
    assert t5["GPS:GPSSpeedRef"] == "km/h" and 3 < t5["GPS:GPSSpeed"] < 40  # simulated ride: 2-8 m/s
    assert "XMP-GPano:PosePitchDegrees" in t5 and t5["XMP-GPano:PosePitchDegrees"] == 0  # pitch/roll untouched
    src = next(p for p in samples.rglob(files[0].name.split("_", 1)[1]))
    assert scan_hash(files[0]) == scan_hash(src), "image data must not be re-encoded"
    assert tags["ExifIFD:DateTimeOriginal"] == reader.dump_all(str(src))["ExifIFD:DateTimeOriginal"]

    # Second sequence: offset applied
    p2 = client.get(f"/api/projects/{pid}/photos").json()
    row2 = next(r for r in p2["rows"] if r[f.index("sequence_id")] == seqs[1]["id"] and r[f.index("heading")] is not None)
    fname = row2[f.index("id")]
    src_name = client.get(f"/api/projects/{pid}/photos/{fname}").json()["filename"]
    m2 = next(m for m in reader.read_batch([str(p) for p in (out / dirs[1]).glob("*.JPG")]) if m.path.endswith("_" + src_name))
    assert m2.heading == pytest.approx(row2[f.index("heading")], abs=0.01)

    report = client.get(f"/api/projects/{pid}/exports").json()
    assert len(report) == 2 and report[0]["report"]["problems"] == {}

    # Re-export replaces the previous export; a foreign non-empty folder is refused
    (out / dirs[0] / "notes.txt").write_text("à garder")
    client.post(f"/api/projects/{pid}/export", json={"out_dir": str(out), "sequence_ids": [seqs[0]["id"]]})
    assert wait_jobs(client, pid)[0]["state"] == "done"
    assert (out / dirs[0] / "notes.txt").exists()
    assert len(list((out / dirs[0]).glob("*.JPG"))) == seqs[0]["count"] - jumps.get(seqs[0]["id"], 0)
    marker = json.loads((out / dirs[0] / ".pss-export.json").read_text())
    assert marker["project_id"] == pid

    foreign = tmp_path / "foreign"
    (foreign / dirs[0]).mkdir(parents=True)
    (foreign / dirs[0] / "x.jpg").write_bytes(b"x")
    client.post(f"/api/projects/{pid}/export", json={"out_dir": str(foreign)})
    j = wait_jobs(client, pid)[0]
    assert j["state"] == "error" and "existe déjà" in j["message"]

    assert tree_hash(samples) == before, "source photos must never be modified"


def test_speeds_along_trajectory():
    from app.exporter import speeds_kmh

    from app.core import geo

    lat, lon, items = 43.6, 3.87, []
    for i in range(4):
        items.append({"ts": 1000 + 2 * i, "lat": None, "lon": None, "lat_orig": lat, "lon_orig": lon})
        lon, lat, _ = geo.GEOD.fwd(lon, lat, 90, 10)  # 10 m every 2 s = 18 km/h
    items.append({"ts": 2000, "lat": None, "lon": None, "lat_orig": lat, "lon_orig": lon})  # after an interruption
    v = speeds_kmh(items)
    assert v[:4] == [pytest.approx(18, abs=0.01)] * 4
    assert v[4] is None


def test_gopro_maker_notes_warnings_are_not_errors(samples, tmp_path):
    """Real GoPro MAX photos make ExifTool warn "[minor] Maker notes could not be parsed" when written:
    a warning, not a failure (it used to be reported as a verification problem on every file but the first)."""
    import shutil

    import piexif

    src = tmp_path / "gopro"
    shutil.copytree(samples / "100GOPRO", src)
    for f in sorted(src.glob("*.JPG"))[:30]:
        d = piexif.load(str(f))
        d["Exif"][piexif.ExifIFD.MakerNote] = bytes(range(7, 200))  # unparsable maker notes, like the GoPro MAX
        piexif.insert(piexif.dump(d), str(f))
    with TestClient(main.app) as client:
        pid = client.post("/api/projects", json={"name": "GoPro"}).json()["id"]
        client.post(f"/api/projects/{pid}/import", json={"paths": [str(src)]})
        wait_jobs(client, pid)
        client.post(f"/api/projects/{pid}/sequences/from-unclassified")
        client.post(f"/api/projects/{pid}/timesync/apply", json={"offset_s": 1.5, "scope": "all"})
        client.post(f"/api/projects/{pid}/export", json={"out_dir": str(tmp_path / "out")})
        j = wait_jobs(client, pid)[0]
        assert j["state"] == "done", j
        reports = client.get(f"/api/projects/{pid}/exports").json()
        assert reports and all(r["report"]["problems"] == {} for r in reports)
        assert reports[0]["report"]["corrected_positions"] > 20
