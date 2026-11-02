import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import db, main
from app.core import geo
from app.exif import reader, writer

from .conftest import tree_hash
from .test_export import scan_hash
from .test_import import wait_jobs


@pytest.fixture()
def project(samples, tmp_path):
    """Project on a private copy of the samples (some tests modify the source photos)."""
    import shutil

    src = tmp_path / "sources"
    shutil.copytree(samples, src)
    with TestClient(main.app) as client:
        pid = client.post("/api/projects", json={"name": "Positions"}).json()["id"]
        client.post(f"/api/projects/{pid}/import", json={"paths": [str(src)]})
        wait_jobs(client, pid)
        props = client.get(f"/api/projects/{pid}/sequences/proposals").json()
        seqs = client.post(f"/api/projects/{pid}/sequences/bulk", json={"segments": [[p["start_idx"], p["end_idx"]] for p in props]}).json()["sequences"]
        yield client, pid, src, seqs


def rows(client, pid):
    r = client.get(f"/api/projects/{pid}/photos").json()
    return [dict(zip(r["fields"], row)) for row in r["rows"]]


def test_set_revert_and_undo_position(project):
    client, pid, _, seqs = project
    p = next(x for x in rows(client, pid) if x["sequence_id"] == seqs[0]["id"] and x["heading"] is not None)
    r = client.put(f"/api/projects/{pid}/photos/{p['id']}/position", json={"lat": 43.6, "lon": 3.9})
    assert r.status_code == 200 and r.json()["undo"]["undo"] == "Position corrigée"
    d = client.get(f"/api/projects/{pid}/photos/{p['id']}").json()
    assert (d["lat"], d["lon"], d["pos_method"]) == (43.6, 3.9, "manual")
    assert (d["lat_orig"], d["lon_orig"]) == (p["lat_orig"], p["lon_orig"])  # original kept
    client.post(f"/api/projects/{pid}/undo")
    assert client.get(f"/api/projects/{pid}/photos/{p['id']}").json()["lat"] is None
    client.post(f"/api/projects/{pid}/redo")
    client.put(f"/api/projects/{pid}/photos/{p['id']}/position", json={})
    assert client.get(f"/api/projects/{pid}/photos/{p['id']}").json()["pos_method"] is None
    assert client.put(f"/api/projects/{pid}/photos/{p['id']}/position", json={"lat": 0.0, "lon": 0.0}).status_code == 409


def test_batch_offset_along_and_heading_recompute(project):
    client, pid, _, seqs = project
    ph = [x for x in rows(client, pid) if x["sequence_id"] == seqs[0]["id"]]
    a, b = ph[10]["idx"], ph[14]["idx"]
    before = {x["id"]: x for x in ph}
    r = client.post(f"/api/projects/{pid}/positions/batch", json={"start_idx": a, "end_idx": b, "mode": "offset", "east_m": 10, "north_m": 0}).json()
    assert r["changed"] == 5
    for x in rows(client, pid):
        if a <= x["idx"] <= b:
            o = before[x["id"]]
            assert geo.distance(o["lat"], o["lon"], x["lat"], x["lon"]) == pytest.approx(10, abs=0.01)
            assert geo.azimuth(o["lat"], o["lon"], x["lat"], x["lon"]) == pytest.approx(90, abs=0.1)
            assert x["pos_method"] == "offset"
    client.post(f"/api/projects/{pid}/positions/batch", json={"start_idx": a, "end_idx": b, "mode": "revert"})
    r = client.post(f"/api/projects/{pid}/positions/batch", json={"start_idx": a, "end_idx": a, "mode": "along", "meters": 3}).json()
    assert r["changed"] == 1
    x = next(x for x in rows(client, pid) if x["idx"] == a)
    assert geo.distance(before[x["id"]]["lat"], before[x["id"]]["lon"], x["lat"], x["lon"]) == pytest.approx(3, abs=0.01)

    # Manual heading next to a moved photo is flagged as to be checked, never overwritten
    m = ph[20]
    client.put(f"/api/projects/{pid}/photos/{m['id']}/heading", json={"value": 12.0})
    client.put(f"/api/projects/{pid}/photos/{ph[21]['id']}/position", json={"lat": 43.605, "lon": 3.879})
    d = client.get(f"/api/projects/{pid}/photos/{m['id']}").json()
    assert d["heading_final"] == 12.0 and d["heading_stale"] == 1


def test_corrected_gps_jump_becomes_usable(project):
    client, pid, _, _ = project
    with db.open_project(pid) as conn:
        jump = conn.execute("SELECT id, idx FROM photo WHERE flags & ? AND sequence_id IS NOT NULL", (db.GPS_JUMP,)).fetchone()
        prev = conn.execute("SELECT lat_orig, lon_orig FROM photo WHERE idx = ?", (jump["idx"] - 1,)).fetchone()
    assert jump is not None
    j = client.get(f"/api/projects/{pid}/photos/{jump['id']}").json()
    assert j["heading_final"] is None
    client.put(f"/api/projects/{pid}/photos/{jump['id']}/position", json={"lat": prev[0] + 0.00005, "lon": prev[1]})
    j = client.get(f"/api/projects/{pid}/photos/{jump['id']}").json()
    assert j["heading_final"] is not None  # usable trajectory point once corrected
    seq = next(s for s in client.get(f"/api/projects/{pid}/sequences").json()["sequences"] if s["id"] == j["sequence_id"])
    assert seq["corrected"] == 1


def test_in_place_export_and_restore(project):
    client, pid, src, seqs = project
    first = next(x for x in rows(client, pid) if x["sequence_id"] == seqs[0]["id"])
    client.put(f"/api/projects/{pid}/photos/{first['id']}/position", json={"lat": 43.61, "lon": 3.871})
    path = Path(client.get(f"/api/projects/{pid}/photos/{first['id']}").json()["path"])
    before_tags = writer.read_tags([str(path)])[str(path)]
    before_scan = scan_hash(path)
    before_mtime = path.stat().st_mtime

    r = client.post(f"/api/projects/{pid}/export", json={"mode": "in_place"})
    assert r.status_code == 202
    j = wait_jobs(client, pid)[0]
    assert j["state"] == "done", j

    m = reader.read_batch([str(path)])[0]
    assert m.heading is not None and (m.lat, m.lon) == (pytest.approx(43.61), pytest.approx(3.871))
    assert scan_hash(path) == before_scan, "image data must not be re-encoded"
    assert path.stat().st_mtime == pytest.approx(before_mtime, abs=1)  # -P keeps the file date
    state = client.get(f"/api/projects/{pid}/sources").json()
    assert state["modified"] == sum(s["count"] for s in seqs) - sum(s["gps_jumps"] for s in seqs) and state["moved"] == 0
    with db.open_project(pid) as conn:
        saved = json.loads(conn.execute("SELECT orig_tags FROM photo WHERE id=?", (first["id"],)).fetchone()[0])
    assert saved == before_tags and "GPSImgDirection" not in saved

    # A second in-place export keeps the very first saved values
    client.post(f"/api/projects/{pid}/export", json={"mode": "in_place"})
    wait_jobs(client, pid)

    client.post(f"/api/projects/{pid}/sources/restore")
    j = wait_jobs(client, pid)[0]
    assert j["kind"] == "restore_sources" and j["state"] == "done", j
    restored = writer.read_tags([str(path)])[str(path)]
    assert set(restored) == set(before_tags)
    for k, v in before_tags.items():
        # Positions are re-encoded from the saved decimal value: identical to 1e-9° (0.1 mm)
        assert restored[k] == (pytest.approx(v, abs=1e-9) if isinstance(v, float) else v), k
    assert reader.read_batch([str(path)])[0].heading is None
    assert scan_hash(path) == before_scan
    assert client.get(f"/api/projects/{pid}/sources").json() == {"modified": 0, "moved": 0}


def test_move_export_rename_and_restore(project, tmp_path):
    client, pid, src, seqs = project
    before = {p: h for p, h in tree_hash(src).items() if p.upper().endswith(".JPG")}
    before_scan = {p: scan_hash(src / p) for p in before if "9999" not in p}  # (9999 is the truncated file)
    out = src / "sequences"  # inside the source folder is allowed when moving
    r = client.post(f"/api/projects/{pid}/export", json={"mode": "move", "out_dir": str(out)})
    assert r.status_code == 202
    j = wait_jobs(client, pid)[0]
    assert j["state"] == "done", j

    dirs = sorted(p.name for p in out.iterdir())
    assert dirs == ["01_Sequence_1", "02_Sequence_2"]
    moved = sorted((out / dirs[0]).glob("*.JPG"))
    assert moved and moved[0].name.startswith("0001_GSAC")
    ph = {x["id"]: x for x in rows(client, pid)}
    with db.open_project(pid) as conn:
        r0 = conn.execute("SELECT path, moved_from FROM photo WHERE path=?", (str(moved[0]),)).fetchone()
    assert r0 is not None and not Path(r0["moved_from"]).exists()  # the file really moved
    assert reader.read_batch([str(moved[0])])[0].heading is not None

    # Rename the sequence and export again: files follow, original path is kept
    client.patch(f"/api/projects/{pid}/sequences/{seqs[0]['id']}", json={"name": "Matin"})
    client.post(f"/api/projects/{pid}/export", json={"mode": "move", "out_dir": str(out)})
    j = wait_jobs(client, pid)[0]
    assert j["state"] == "done", j
    assert len(list((out / "01_Matin").glob("*.JPG"))) == len(moved)
    assert not list((out / "01_Sequence_1").glob("*.JPG"))
    with db.open_project(pid) as conn:
        r1 = conn.execute("SELECT moved_from FROM photo WHERE path LIKE ?", (str(out / "01_Matin" / "0001_%"),)).fetchone()
    assert r1["moved_from"] == r0["moved_from"]

    # Re-import of the source folder does not duplicate moved photos
    n = len(ph)
    client.post(f"/api/projects/{pid}/import", json={"paths": [str(src)]})
    wait_jobs(client, pid)
    assert len(rows(client, pid)) == n

    client.post(f"/api/projects/{pid}/sources/restore")
    j = wait_jobs(client, pid)[0]
    assert j["state"] == "done", j
    after = {p: h for p, h in tree_hash(src).items() if p.upper().endswith(".JPG")}
    assert set(after) == set(before), "every photo is back at its original path"
    for p, h in before_scan.items():
        assert scan_hash(src / p) == h, p  # image data never re-encoded
    metas = reader.read_batch([str(src / p) for p in before_scan])
    assert all(m.heading is None for m in metas)  # tags restored (the originals had no heading)


def test_pose_heading_written_by_older_version_is_restored(project):
    """Versions before 2026-11 wrote the heading in PoseHeadingDegrees: a new export puts the camera's value back."""
    import subprocess

    client, pid, src, seqs = project
    first = next(x for x in rows(client, pid) if x["sequence_id"] == seqs[0]["id"])
    path = client.get(f"/api/projects/{pid}/photos/{first['id']}").json()["path"]
    orig = writer.read_tags([path])[path]
    assert orig["PoseHeadingDegrees"] == 0
    with db.open_project(pid) as conn:  # state left by an older version
        conn.execute("UPDATE photo SET orig_tags=?, source_written_at=1 WHERE id=?", (json.dumps(orig), first["id"]))
    subprocess.run(["exiftool", "-q", "-overwrite_original", "-XMP-GPano:PoseHeadingDegrees=254", path], check=True)
    client.post(f"/api/projects/{pid}/export", json={"mode": "in_place"})
    assert wait_jobs(client, pid)[0]["state"] == "done"
    assert writer.read_tags([path])[path]["PoseHeadingDegrees"] == 0
