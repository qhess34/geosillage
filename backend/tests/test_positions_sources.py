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
    assert client.get(f"/api/projects/{pid}/sources").json() == {"modified": 0, "moved": 0, "trashed": 0}


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
    assert dirs == ["Positions_1", "Positions_2"]
    moved = sorted((out / dirs[0]).glob("*.JPG"))
    assert moved and moved[0].name.startswith("0001_GSAC")
    ph = {x["id"]: x for x in rows(client, pid)}
    with db.open_project(pid) as conn:
        r0 = conn.execute("SELECT path, moved_from FROM photo WHERE path=?", (str(moved[0]),)).fetchone()
    assert r0 is not None and not Path(r0["moved_from"]).exists()  # the file really moved
    assert reader.read_batch([str(moved[0])])[0].heading is not None

    # Cut the first sequence and export again: files follow their new sequence folder, original path is kept
    first_seq = [x for x in rows(client, pid) if x["sequence_id"] == seqs[0]["id"]]
    client.post(f"/api/projects/{pid}/sequences/cut", params={"photo_id": first_seq[50]["id"]})
    client.post(f"/api/projects/{pid}/export", json={"mode": "move", "out_dir": str(out)})
    j = wait_jobs(client, pid)[0]
    assert j["state"] == "done", j
    assert sorted(p.name for p in out.iterdir()) == ["Positions_1", "Positions_2", "Positions_3"]
    n1 = len(list((out / "Positions_1").glob("*.JPG")))
    n2 = len(list((out / "Positions_2").glob("*.JPG")))
    assert n1 + n2 == len(moved) and n1 == 50 - sum(1 for x in first_seq[:50] if x["flags"] & 16)
    with db.open_project(pid) as conn:
        r1 = conn.execute("SELECT moved_from FROM photo WHERE path LIKE ?", (str(out / "Positions_1" / "0001_%"),)).fetchone()
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


def test_exclude_cut_and_trash(samples, tmp_path):
    import shutil

    src = tmp_path / "src"
    shutil.copytree(samples, src)
    with TestClient(main.app) as client:
        pid = client.post("/api/projects", json={"name": "Découpe"}).json()["id"]
        client.post(f"/api/projects/{pid}/import", json={"paths": [str(src)]})
        wait_jobs(client, pid)
        ph = [x for x in rows(client, pid) if x["flags"] == 0]

        # One key, from scratch: cut at photo 40, then at photo 80 -> 3 sequences covering the ride
        r = client.post(f"/api/projects/{pid}/sequences/cut", params={"photo_id": ph[40]["id"]}).json()
        assert r["done"] == "Séquence créée et coupée" and len(r["sequences"]) == 2
        r = client.post(f"/api/projects/{pid}/sequences/cut", params={"photo_id": ph[80]["id"]}).json()
        assert r["done"] == "Séquence coupée" and len(r["sequences"]) == 3
        assert r["sequences"][1]["start_idx"] == ph[40]["idx"] and r["sequences"][2]["start_idx"] == ph[80]["idx"]
        assert client.post(f"/api/projects/{pid}/sequences/cut", params={"photo_id": ph[80]["id"]}).status_code == 409
        total = sum(s["count"] for s in r["sequences"])

        # Exclude a series of photos while browsing, put one back: it returns into its sequence
        ids = [ph[i]["id"] for i in (50, 51, 52)]
        r = client.post(f"/api/projects/{pid}/photos/exclude", json={"photo_ids": ids}).json()
        assert r["changed"] == 3 and sum(s["count"] for s in r["sequences"]) == total - 3
        r = client.post(f"/api/projects/{pid}/photos/exclude", json={"photo_ids": [ids[1]], "excluded": False}).json()
        assert sum(s["count"] for s in r["sequences"]) == total - 2
        assert next(x for x in rows(client, pid) if x["id"] == ids[1])["sequence_id"] == r["sequences"][1]["id"]
        assert client.get(f"/api/projects/{pid}").json()["summary"]["excluded"] == 2
        # Excluded photos cannot be put in a sequence
        seq_ids = {x["id"] for x in rows(client, pid) if x["sequence_id"] is not None}
        assert ids[0] not in seq_ids and ids[2] not in seq_ids
        u = client.post(f"/api/projects/{pid}/undo").json()
        assert u["done"].startswith("Réintégration")

        # Trash: files of excluded photos go to _exclues/ next to them, and come back on restore
        before = Path(client.get(f"/api/projects/{pid}/photos/{ids[0]}").json()["path"])
        client.post(f"/api/projects/{pid}/sources/trash-excluded")
        j = wait_jobs(client, pid)[0]
        assert j["kind"] == "trash" and j["state"] == "done", j
        after = Path(client.get(f"/api/projects/{pid}/photos/{ids[0]}").json()["path"])
        assert after == before.parent / "_exclues" / before.name and after.exists() and not before.exists()
        assert client.get(f"/api/projects/{pid}/sources").json()["trashed"] == 3
        client.post(f"/api/projects/{pid}/sources/restore")
        assert wait_jobs(client, pid)[0]["state"] == "done"
        assert before.exists() and not after.exists()
        assert client.get(f"/api/projects/{pid}/sources").json() == {"modified": 0, "moved": 0, "trashed": 0}


def test_default_names_follow_the_ride(project):
    client, pid, _, seqs = project
    ph = [x for x in rows(client, pid) if x["sequence_id"] == seqs[0]["id"]]
    client.patch(f"/api/projects/{pid}/sequences/{seqs[1]['id']}", json={"name": "Retour"})
    r = client.post(f"/api/projects/{pid}/sequences/cut", params={"photo_id": ph[30]["id"]}).json()
    assert [s["name"] for s in r["sequences"]] == ["Séquence 1", "Séquence 2", "Retour"]
    r = client.post(f"/api/projects/{pid}/sequences/cut", params={"photo_id": ph[10]["id"]}).json()
    assert [s["name"] for s in r["sequences"]] == ["Séquence 1", "Séquence 2", "Séquence 3", "Retour"]
    r = client.post(f"/api/projects/{pid}/sequences/merge", json={"ids": [r["sequences"][0]["id"], r["sequences"][1]["id"]]}).json()
    assert [s["name"] for s in r["sequences"]] == ["Séquence 1", "Séquence 2", "Retour"]


def test_helmet_yaw_written_to_xmp(project, tmp_path):
    """Helmet camera: the bike direction stays in GPSImgDirection, the head angle goes to PoseHeadingDegrees."""
    client, pid, src, seqs = project
    ph = [x for x in rows(client, pid) if x["sequence_id"] == seqs[0]["id"] and x["heading"] is not None]
    a, b = ph[5], ph[7]
    r = client.post(f"/api/projects/{pid}/headings/yaw", json={"photo_ids": [a["id"], ph[6]["id"], b["id"]], "yaw": -30}).json()
    assert r["changed"] == 3 and r["undo"]["undo"].startswith("Sens de déplacement fixé")
    d = client.get(f"/api/projects/{pid}/photos/{a['id']}").json()
    assert d["yaw_offset"] == -30 and d["heading_final"] == pytest.approx(a["heading"])  # bike direction unchanged

    out = tmp_path / "out"
    client.post(f"/api/projects/{pid}/export", json={"out_dir": str(out), "sequence_ids": [seqs[0]["id"]]})
    assert wait_jobs(client, pid)[0]["state"] == "done"
    name = Path(client.get(f"/api/projects/{pid}/photos/{a['id']}").json()["path"]).name
    f = next((out / "Positions_1").glob(f"*_{name}"))
    t = writer.read_tags([str(f)])[str(f)]
    assert t["PoseHeadingDegrees"] == 330 and t["GPSImgDirection"] == pytest.approx(a["heading"], abs=0.01)
    # Panoramax only applies the orientation when pitch AND roll are non-zero: the GoPro's 0.0 become 0.01
    assert (t["PosePitchDegrees"], t["PoseRollDegrees"]) == (writer.NUDGE, writer.NUDGE)
    other = next((out / "Positions_1").glob("0001_*"))
    o = writer.read_tags([str(other)])[str(other)]
    assert (o["PoseHeadingDegrees"], o["PosePitchDegrees"], o["PoseRollDegrees"]) == (0, 0, 0)  # untouched

    # In place, then back to 0: the camera's value is written again
    client.post(f"/api/projects/{pid}/export", json={"mode": "in_place", "sequence_ids": [seqs[0]["id"]]})
    assert wait_jobs(client, pid)[0]["state"] == "done"
    path = client.get(f"/api/projects/{pid}/photos/{a['id']}").json()["path"]
    assert writer.read_tags([path])[path]["PoseHeadingDegrees"] == 330
    client.post(f"/api/projects/{pid}/headings/yaw", json={"photo_ids": [a["id"]], "yaw": None})
    client.post(f"/api/projects/{pid}/export", json={"mode": "in_place", "sequence_ids": [seqs[0]["id"]]})
    assert wait_jobs(client, pid)[0]["state"] == "done"
    t = writer.read_tags([path])[path]
    assert (t["PoseHeadingDegrees"], t["PosePitchDegrees"], t["PoseRollDegrees"]) == (0, 0, 0)  # camera values back


def test_all_unclassified_in_sequences(samples):
    with TestClient(main.app) as client:
        pid = client.post("/api/projects", json={"name": "Tout"}).json()["id"]
        client.post(f"/api/projects/{pid}/import", json={"paths": [str(samples)]})
        wait_jobs(client, pid)
        r = client.post(f"/api/projects/{pid}/sequences/from-unclassified").json()
        assert len(r["sequences"]) == 1 and r["sequences"][0]["count"] == 116  # usable photos of the ride
        assert client.post(f"/api/projects/{pid}/sequences/from-unclassified").status_code == 409


def test_camera_backwards_sequence_rotation(project, tmp_path):
    """Camera mounted backwards: +180° on a whole sequence (on top of per-photo head angles), JPEG untouched."""
    from .test_export import scan_hash

    client, pid, src, seqs = project
    ph = [x for x in rows(client, pid) if x["sequence_id"] == seqs[0]["id"]]
    client.post(f"/api/projects/{pid}/headings/yaw", json={"photo_ids": [ph[3]["id"]], "yaw": 30})
    r = client.post(f"/api/projects/{pid}/headings/yaw", json={"sequence_id": seqs[0]["id"], "add": 180}).json()
    assert r["changed"] == seqs[0]["count"] and r["undo"]["undo"].startswith("Rotation de +180°")
    assert client.get(f"/api/projects/{pid}/photos/{ph[0]['id']}").json()["yaw_offset"] == -180
    assert client.get(f"/api/projects/{pid}/photos/{ph[3]['id']}").json()["yaw_offset"] == -150  # 30 + 180
    other = next(x for x in rows(client, pid) if x["sequence_id"] == seqs[1]["id"])
    assert client.get(f"/api/projects/{pid}/photos/{other['id']}").json()["yaw_offset"] is None

    out = tmp_path / "out"
    client.post(f"/api/projects/{pid}/export", json={"out_dir": str(out), "sequence_ids": [seqs[0]["id"]]})
    assert wait_jobs(client, pid)[0]["state"] == "done"
    f = next((out / "Positions_1").glob("0001_*"))
    src_file = Path(client.get(f"/api/projects/{pid}/photos/{ph[0]['id']}").json()["path"])
    t = writer.read_tags([str(f)])[str(f)]
    assert (t["PoseHeadingDegrees"], t["PosePitchDegrees"], t["PoseRollDegrees"]) == (180, writer.NUDGE, writer.NUDGE)
    assert scan_hash(f) == scan_hash(src_file)  # image data untouched

    # Rotating again by 180° goes back to the original values
    client.post(f"/api/projects/{pid}/headings/yaw", json={"sequence_id": seqs[0]["id"], "add": 180})
    assert client.get(f"/api/projects/{pid}/photos/{ph[0]['id']}").json()["yaw_offset"] is None
    assert client.get(f"/api/projects/{pid}/photos/{ph[3]['id']}").json()["yaw_offset"] == 30


def test_rotate_all_photos(project):
    client, pid, _, seqs = project
    allp = rows(client, pid)
    r = client.post(f"/api/projects/{pid}/headings/yaw", json={"all": True, "add": 180}).json()
    assert r["changed"] == len(allp)
    unclassified = next(x for x in allp if x["sequence_id"] is None)
    assert client.get(f"/api/projects/{pid}/photos/{unclassified['id']}").json()["yaw_offset"] == -180
    client.post(f"/api/projects/{pid}/undo")
    assert client.get(f"/api/projects/{pid}/photos/{unclassified['id']}").json()["yaw_offset"] is None



def test_yaw_sign_migration(project):
    """Yaws fixed with the former (GPano pose) convention are flipped to the Panoramax viewer convention."""
    client, pid, _, seqs = project
    ph = [x for x in rows(client, pid) if x["sequence_id"] == seqs[0]["id"]]
    with db.open_project(pid) as conn:
        conn.executemany("UPDATE photo SET yaw_offset=? WHERE id=?", [(30, ph[0]["id"]), (-180, ph[1]["id"]), (-170, ph[2]["id"])])
        flip = next(i for i, m in enumerate(db.MIGRATIONS) if "yaw_offset = CASE" in m)
        conn.execute(f"PRAGMA user_version={flip}")
        # later migrations are replayed too: the columns they add are dropped first
        conn.executescript("ALTER TABLE sequence DROP COLUMN modified_at; ALTER TABLE photo DROP COLUMN pitch_orig; ALTER TABLE photo DROP COLUMN roll_orig")
        db.migrate(conn)
        got = [conn.execute("SELECT yaw_offset FROM photo WHERE id=?", (ph[i]["id"],)).fetchone()[0] for i in range(3)]
    assert got == [-30, -180, 170]


def _make_gap(pid, seq, start, n=3):
    """Photos start..start+n-1 of the sequence lose their GPS (as when the receiver drops) and leave the sequence."""
    from app.core import sequences as core_seq

    with db.open_project(pid) as conn:
        ids = [r[0] for r in conn.execute("SELECT id FROM photo WHERE sequence_id=? ORDER BY idx LIMIT ? OFFSET ?", (seq["id"], n, start))]
        conn.executemany(
            f"UPDATE photo SET lat_orig=NULL, lon_orig=NULL, flags=flags|{db.NO_GPS}, sequence_id=NULL, rank=NULL WHERE id=?",
            [(i,) for i in ids],
        )
        core_seq._renumber(conn, seq["id"])
    return ids


def test_missing_positions_interpolated_and_attached(project):
    client, pid, _, seqs = project
    gap = _make_gap(pid, seqs[0], 40)
    runs = client.get(f"/api/projects/{pid}/positions/missing").json()
    run = next(r for r in runs if r["ids"] == gap)
    assert run["count"] == 3 and run["sequence_id"] == seqs[0]["id"]
    assert run["prev"]["idx"] == run["start_idx"] - 1 and run["next"]["idx"] == run["end_idx"] + 1
    count_before = next(s for s in client.get(f"/api/projects/{pid}/sequences").json()["sequences"] if s["id"] == seqs[0]["id"])["count"]

    r = client.post(f"/api/projects/{pid}/positions/batch", json={"photo_ids": gap, "mode": "interpolate"}).json()
    assert (r["changed"], r["skipped"], r["attached"]) == (3, 0, 3)
    a, b = run["prev"], run["next"]
    total = geo.distance(a["lat"], a["lon"], b["lat"], b["lon"])
    for pid_ in gap:
        d = client.get(f"/api/projects/{pid}/photos/{pid_}").json()
        assert d["pos_method"] == "interp" and d["sequence_id"] == seqs[0]["id"]
        f = (d["ts"] - a["ts"]) / (b["ts"] - a["ts"])
        assert geo.distance(a["lat"], a["lon"], d["lat"], d["lon"]) == pytest.approx(total * f, abs=0.05)
    seq = next(s for s in client.get(f"/api/projects/{pid}/sequences").json()["sequences"] if s["id"] == seqs[0]["id"])
    assert seq["count"] == count_before + 3
    assert not any(r["ids"] == gap for r in client.get(f"/api/projects/{pid}/positions/missing").json())
    # a later time sync keeps interpolated positions (treated as manual corrections)
    sync = client.post(f"/api/projects/{pid}/timesync/apply", json={"offset_s": 1.0, "scope": "all", "keep_manual": True}).json()
    assert sync["kept_manual"] >= 3
    # one undo removes the positions and the attachment
    client.post(f"/api/projects/{pid}/undo")
    client.post(f"/api/projects/{pid}/undo")
    d = client.get(f"/api/projects/{pid}/photos/{gap[0]}").json()
    assert (d["lat"], d["pos_method"], d["sequence_id"]) == (None, None, None)


def test_placing_one_photo_by_hand_attaches_it(project):
    client, pid, _, seqs = project
    gap = _make_gap(pid, seqs[0], 20, n=1)
    client.put(f"/api/projects/{pid}/photos/{gap[0]}/position", json={"lat": 43.61, "lon": 3.88})
    d = client.get(f"/api/projects/{pid}/photos/{gap[0]}").json()
    assert d["sequence_id"] == seqs[0]["id"] and d["pos_method"] == "manual"


def test_gap_at_the_start_cannot_be_interpolated(project):
    client, pid, _, _ = project
    runs = client.get(f"/api/projects/{pid}/positions/missing").json()
    first = runs[0]
    assert first["prev"] is None  # the simulated ride starts without a GPS fix
    r = client.post(f"/api/projects/{pid}/positions/batch", json={"photo_ids": first["ids"], "mode": "interpolate"}).json()
    assert r["changed"] == 0 and r["skipped"] == len(first["ids"])
