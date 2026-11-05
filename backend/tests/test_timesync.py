import csv
import statistics

import pytest
from fastapi.testclient import TestClient

from app import db, main
from app.core import geo, timesync

from .test_import import wait_jobs


def straight_track(n=10, step=10.0, dt=2.0, az=90.0):
    run, (lat, lon) = [], (43.6, 3.87)
    for i in range(n):
        run.append((1000 + i * dt, lat, lon))
        lon, lat, _ = geo.GEOD.fwd(lon, lat, az, step)
    return [run]


def test_position_at_interpolates_on_the_track():
    tr = straight_track()
    lat, lon = timesync.position_at(tr, 1003.0)  # halfway between points 1 and 2
    assert geo.distance(tr[0][0][1], tr[0][0][2], lat, lon) == pytest.approx(15.0, abs=0.01)
    # small extrapolation past the end, none beyond the limit or inside an interruption
    lat, lon = timesync.position_at(tr, 1018.0 + 2.0)
    assert geo.distance(tr[0][-1][1], tr[0][-1][2], lat, lon) == pytest.approx(10.0, abs=0.01)
    assert timesync.position_at(tr, 1018.0 + 6.0) is None
    tr2 = tr + [[(2000.0, 43.7, 3.9), (2002.0, 43.7001, 3.9)]]
    assert timesync.position_at(tr2, 1500.0) is None


def test_position_follows_a_turn():
    # Right-angle turn: interpolation stays on the two legs, never cuts the corner
    a = (1000.0, 43.6, 3.87)
    lon_b, lat_b, _ = geo.GEOD.fwd(a[2], a[1], 0, 10)
    b = (1002.0, lat_b, lon_b)
    lon_c, lat_c, _ = geo.GEOD.fwd(lon_b, lat_b, 90, 10)
    c = (1004.0, lat_c, lon_c)
    lat, lon = timesync.position_at([[a, b, c]], 1003.0)
    assert geo.distance(lat_b, lon_b, lat, lon) == pytest.approx(5.0, abs=0.01)
    assert geo.azimuth(lat_b, lon_b, lat, lon) == pytest.approx(90, abs=0.1)


def test_offset_for_point():
    tr = straight_track()
    photo_ts, plat, plon = tr[0][3]
    lon_t, lat_t, _ = geo.GEOD.fwd(plon, plat, 90, 7.5)  # 1.5 s ahead at 5 m/s
    lon_off, lat_off, _ = geo.GEOD.fwd(lon_t, lat_t, 0, 3)  # dropped 3 m beside the track
    off, slat, slon = timesync.offset_for_point(tr, photo_ts, lat_off, lon_off)
    assert off == pytest.approx(1.5, abs=0.01)
    assert geo.distance(slat, slon, lat_t, lon_t) < 0.05
    # Only the part of the track near the photo time is used
    with pytest.raises(timesync.SyncError):
        timesync.offset_for_point(tr, 5000.0, lat_t, lon_t)


@pytest.fixture()
def project(samples):
    with TestClient(main.app) as client:
        pid = client.post("/api/projects", json={"name": "Synchro"}).json()["id"]
        client.post(f"/api/projects/{pid}/import", json={"paths": [str(samples)]})
        wait_jobs(client, pid)
        yield client, pid


def errors_vs_truth(pid, samples):
    truth = {r["file"].split("/")[-1]: r for r in csv.DictReader(open(samples / "verite_terrain.csv"))}
    with db.open_project(pid) as conn:
        rows = conn.execute(
            f"SELECT filename, COALESCE(lat, lat_orig), COALESCE(lon, lon_orig), flags FROM photo WHERE path LIKE '%GOPRO%'"
        ).fetchall()
    out = []
    for fn, lat, lon, flags in rows:
        t = truth[fn]
        if lat is None or t["jump"] == "1" and flags & db.GPS_JUMP and lat is None:
            continue
        out.append(geo.distance(float(t["true_lat"]), float(t["true_lon"]), lat, lon))
    return out


def test_sync_on_simulated_ride(project, samples):
    """Measure the offset on one photo from its true position, apply it: positions get closer to the truth."""
    client, pid = project
    truth = list(csv.DictReader(open(samples / "verite_terrain.csv")))
    delays = [float(r["delay_s"]) for r in truth]
    before = errors_vs_truth(pid, samples)

    # "Drag" a photo to its true position (what the user does with a feature on the satellite view)
    ref = truth[30]
    with db.open_project(pid) as conn:
        photo = conn.execute("SELECT id FROM photo WHERE filename=? AND path LIKE '%100GOPRO%'", (ref["file"].split("/")[-1],)).fetchone()
    r = client.get(f"/api/projects/{pid}/timesync/offset", params={"photo_id": photo["id"], "lat": ref["true_lat"], "lon": ref["true_lon"]}).json()
    assert r["offset_s"] == pytest.approx(float(ref["delay_s"]), abs=0.6)

    res = client.post(f"/api/projects/{pid}/timesync/apply", json={"offset_s": r["offset_s"], "scope": "all"}).json()
    assert res["changed"] > 100 and res["undo"]["undo"].startswith("Synchronisation")
    after = errors_vs_truth(pid, samples)
    med_b, med_a = statistics.median(before), statistics.median(after)
    assert med_a < med_b * 0.6, (med_b, med_a)
    # GPS jumps are placed back on the itinerary
    with db.open_project(pid) as conn:
        jumps = conn.execute("SELECT filename, lat, lon FROM photo WHERE flags & ? AND path LIKE '%GOPRO%'", (db.GPS_JUMP,)).fetchall()
    tmap = {r["file"].split("/")[-1]: r for r in truth}
    for fn, lat, lon in jumps:
        if lat is not None:
            assert geo.distance(float(tmap[fn]["true_lat"]), float(tmap[fn]["true_lon"]), lat, lon) < 20
    print(f"median error {med_b:.1f} m -> {med_a:.1f} m (mean delay {statistics.mean(delays):.2f} s, offset {r['offset_s']} s)")

    client.post(f"/api/projects/{pid}/undo")
    assert statistics.median(errors_vs_truth(pid, samples)) == pytest.approx(med_b)


def test_sync_keeps_manual_and_scopes(project):
    client, pid = project
    rows = client.get(f"/api/projects/{pid}/photos").json()
    f = rows["fields"]
    good = [r for r in rows["rows"] if r[f.index("flags")] == 0]
    manual = good[10]
    client.put(f"/api/projects/{pid}/photos/{manual[0]}/position", json={"lat": 43.6, "lon": 3.9})
    a, b = good[5][f.index("idx")], good[15][f.index("idx")]
    res = client.post(f"/api/projects/{pid}/timesync/apply", json={"offset_s": 1.5, "scope": "range", "start_idx": a, "end_idx": b}).json()
    assert res["kept_manual"] == 1 and res["changed"] >= 9
    d = client.get(f"/api/projects/{pid}/photos/{manual[0]}").json()
    assert (d["lat"], d["pos_method"]) == (43.6, "manual")
    other = client.get(f"/api/projects/{pid}/photos/{good[6][0]}").json()
    assert other["pos_method"] == "time" and other["time_offset"] == 1.5
    outside = client.get(f"/api/projects/{pid}/photos/{good[20][0]}").json()
    assert outside["pos_method"] is None
    client.put(f"/api/projects/{pid}/timesync/points", json=[{"photo_id": good[6][0], "offset_s": 1.4}])
    assert client.get(f"/api/projects/{pid}/timesync/points").json()["points"] == [{"photo_id": good[6][0], "offset_s": 1.4}]
    t = client.get(f"/api/projects/{pid}/track").json()
    assert len(t["runs"]) == 2 and len(t["runs"][0][0]) == 3  # two runs: cut at the interruption


def test_sync_from_photo_leaves_earlier_photos(project, tmp_path):
    """Offset changing during a ride: a later sync 'from' a photo does not touch (nor mark for re-export) earlier ones."""
    client, pid = project
    props = client.get(f"/api/projects/{pid}/sequences/proposals").json()
    seqs = client.post(f"/api/projects/{pid}/sequences/bulk", json={"segments": [[p["start_idx"], p["end_idx"]] for p in props]}).json()["sequences"]
    assert len(seqs) == 2
    client.post(f"/api/projects/{pid}/timesync/apply", json={"offset_s": 2.0, "scope": "all"})
    client.post(f"/api/projects/{pid}/export", json={"out_dir": str(tmp_path / "out")})
    wait_jobs(client, pid)
    assert not any(s["needs_export"] for s in client.get(f"/api/projects/{pid}/sequences").json()["sequences"])
    before = client.get(f"/api/projects/{pid}/photos").json()
    start = seqs[1]["start_idx"]
    r = client.post(f"/api/projects/{pid}/timesync/apply", json={"offset_s": 1.0, "scope": "from", "start_idx": start}).json()
    assert r["changed"] > 0 and r["undo"]["undo"].startswith("Synchronisation +1.0 s à partir de la photo")
    after = client.get(f"/api/projects/{pid}/photos").json()
    f = before["fields"]
    for b, a in zip(before["rows"], after["rows"]):
        if b[f.index("idx")] < start:
            assert a == b
    states = {s["id"]: s["needs_export"] for s in client.get(f"/api/projects/{pid}/sequences").json()["sequences"]}
    assert states == {seqs[0]["id"]: False, seqs[1]["id"]: True}
    d = client.get(f"/api/projects/{pid}/photos/{after['rows'][-2][0]}").json()
    assert d["time_offset"] == 1.0
    assert client.post(f"/api/projects/{pid}/timesync/apply", json={"offset_s": 1.0, "scope": "from"}).status_code == 400
