import csv

import pytest

from app import db
from app.core import geo, headings
from app.core.headings import Pt
from app.exif import writer


def line(n, az, step=10.0, dt=2.0, start=(43.6, 3.87)):
    pts, (lat, lon) = [], start
    for i in range(n):
        pts.append(Pt(i + 1, 1000 + i * dt, lat, lon, 0))
        lon, lat, _ = geo.GEOD.fwd(lon, lat, az, step)
    return pts


@pytest.mark.parametrize("az", [0.0, 45.0, 90.0, 180.0, 271.0, 359.0])
def test_straight_line(az):
    res = headings.compute(line(10, az))
    for h, st in res.values():
        assert st == "ok"
        assert abs(((h - az) + 180) % 360 - 180) < 0.01


def test_last_photo_uses_previous_point():
    res = headings.compute(line(5, 90.0))
    assert res[5][0] == pytest.approx(90.0, abs=0.01)


def test_short_steps_look_further_ahead():
    # 2 m between photos: the 5 m target is 3 photos ahead, still the right direction
    res = headings.compute(line(10, 30.0, step=2.0), min_m=5.0)
    assert all(abs(h - 30.0) < 0.01 for h, _ in res.values())


def test_stop_takes_direction_of_arrival():
    # rider stopped after riding east: 10 photos at the same place, no movement within the time window. The photo
    # kept from a stop (the others excluded) must keep a heading: the direction of arrival
    ride = line(5, 90.0)
    end = ride[-1]
    stopped = [Pt(100 + i, end.ts + 2 + i * 2, end.lat, end.lon, 0) for i in range(10)]
    # then leaves northwards: the stop is not at the end of the run
    after = [Pt(200 + i, stopped[-1].ts + 2 + i * 2, end.lat + 0.0002 * (i + 1), end.lon, 0) for i in range(3)]
    res = headings.compute(ride + stopped + after)
    # beginning of the stop: nothing ahead within the window -> direction of arrival (the last ones, close to the
    # departure, look ahead as usual)
    for p in stopped[:4]:
        assert res[p.id][1] == "stop" and res[p.id][0] == pytest.approx(90.0, abs=0.01)
    assert all(res[p.id][0] is not None for p in stopped)


def test_stop_at_start_takes_direction_of_departure():
    start = line(5, 180.0)
    stopped = [Pt(100 + i, start[0].ts - 40 + i * 2, start[0].lat, start[0].lon, 0) for i in range(10)]
    res = headings.compute(stopped + start)
    assert all(res[p.id][1] == "stop" and res[p.id][0] == pytest.approx(180.0, abs=0.01) for p in stopped)


def test_never_moving_is_uncertain_not_invented():
    stopped = [Pt(100 + i, 5000 + i * 2, 43.61, 3.88, 0) for i in range(10)]
    res = headings.compute(stopped)
    assert all(res[p.id] == (None, "uncertain") for p in stopped)


def test_never_across_interruption_and_unusable_points():
    a = line(4, 0.0)
    b = line(4, 90.0, start=(43.7, 3.9))
    for p in b:
        p.id += 10
        p.ts += 600
    b[0].flags = db.GAP_BEFORE
    a[2].flags = db.GPS_JUMP
    res = headings.compute(a + b)
    assert res[3] == (None, "missing")
    assert res[4][0] == pytest.approx(0.0, abs=0.01)  # end of first run: backwards, not towards the next run
    assert res[11][0] == pytest.approx(90.0, abs=0.01)


def test_final_heading_and_wraparound():
    assert headings.final_heading(None, 350.0, 15.0) == pytest.approx(5.0)
    assert headings.final_heading(None, 10.0, -20.0) == pytest.approx(350.0)
    assert headings.final_heading(123.0, 350.0, 15.0) == 123.0  # manual wins, offset not applied
    assert headings.final_heading(None, None, 15.0) is None


def test_panoramax_zero_heading_rule():
    assert writer.heading_value(0.2, True) == 0.6
    assert writer.heading_value(359.7, True) == 0.6
    assert writer.heading_value(359.7, False) == 359.7
    assert writer.heading_value(0.2, False) == 0.2
    assert writer.heading_value(181.234, True) == 181.23


def test_accuracy_on_simulated_ride(samples):
    """Computed headings (from delayed, noisy GPS) vs the true direction of travel."""
    from app.exif import reader

    truth = list(csv.DictReader(open(samples / "verite_terrain.csv")))
    metas = {m.path: m for m in reader.read_batch([str(samples / r["file"]) for r in truth])}
    pts, true_dir = [], {}
    for i, r in enumerate(truth):
        m = metas[str(samples / r["file"])]
        if m.lat is None or r["jump"] == "1":
            continue
        pts.append(Pt(i, float(r["t_s"]), m.lat, m.lon, 0))
        if i + 1 < len(truth):
            n = truth[i + 1]
            true_dir[i] = geo.azimuth(float(r["true_lat"]), float(r["true_lon"]), float(n["true_lat"]), float(n["true_lon"]))
    for a, b in zip(pts, pts[1:]):
        if b.ts - a.ts > 10:
            b.flags = db.GAP_BEFORE
    res = headings.compute(pts)
    errors = sorted(abs(((h - true_dir[i]) + 180) % 360 - 180) for i, (h, st) in res.items() if h is not None and i in true_dir)
    median = errors[len(errors) // 2]
    assert len(errors) > 100
    assert median < 12, median


def test_default_points_to_the_next_photo_in_a_turn():
    """Photos ~5 m apart in a bend: with the default setting each arrow points to the next photo."""
    from app import config

    pts, lat, lon, az = [], 43.6, 3.87, 180.0
    for i in range(12):
        pts.append(Pt(i + 1, 1000 + 2 * i, lat, lon, 0))
        lon, lat, _ = geo.GEOD.fwd(lon, lat, az, 5)
        az = (az - 20) % 360  # turning left by 20° per photo
    res = headings.compute(pts, config.DEFAULT_SETTINGS["heading_min_m"], config.DEFAULT_SETTINGS["heading_window_s"])
    for a, b in zip(pts, pts[1:]):
        assert res[a.id][0] == pytest.approx(geo.azimuth(a.lat, a.lon, b.lat, b.lon), abs=0.01)


def test_device_heading_detection_and_written_value():
    assert headings.device_usable([10.0, 12.0, None, 200.0])
    assert not headings.device_usable([None, None, 10.0])  # absent on most photos
    assert not headings.device_usable([0.0, 0.0, 0.0])  # all 0
    assert not headings.device_usable([45.0, 45.0, 45.2])  # constant
    assert not headings.device_usable([])
    # 360°: yaw goes to XMP-GPano; flat: camera direction = heading + yaw, unless the compass gives it
    assert headings.written(90.0, 180.0, 1, headings.TRACK) == 90.0
    assert headings.written(90.0, 180.0, 0, headings.TRACK) == 270.0
    assert headings.written(300.0, 90.0, 0, headings.TRACK) == 30.0
    assert headings.written(90.0, 180.0, 0, headings.DEVICE) == 90.0
    assert headings.written(None, 180.0, 0, headings.TRACK) is None


def _finals(pid):
    with db.open_project(pid) as conn:
        return conn.execute(f"SELECT p.heading_exif, {headings.FINAL_SQL} FROM photo p ORDER BY p.idx").fetchall()


def test_heading_source_detected_switched_and_undone(flat_samples, flat_track_samples):
    from fastapi.testclient import TestClient

    from app import main

    from .test_import import wait_jobs

    with TestClient(main.app) as client:
        pid = client.post("/api/projects", json={"name": "Boussole"}).json()["id"]
        client.post(f"/api/projects/{pid}/import", json={"paths": [str(flat_samples)]})
        wait_jobs(client, pid)
        p = client.get(f"/api/projects/{pid}").json()
        assert p["heading_source"] == "device" and p["device_headings"] > 0
        rows = [r for r in _finals(pid) if r[0] is not None]
        assert rows and all(abs(((f - e) + 180) % 360 - 180) < 0.01 for e, f in rows)  # the camera's compass
        # back to the track: undoable
        r = client.put(f"/api/projects/{pid}/headings/source", json={"source": "track"})
        assert r.status_code == 200 and r.json()["undo"]["undo"] == "Cap calculé depuis la trace"
        assert client.get(f"/api/projects/{pid}").json()["heading_source"] == "track"
        assert client.post(f"/api/projects/{pid}/undo").status_code == 200
        assert client.get(f"/api/projects/{pid}").json()["heading_source"] == "device"
        assert all(abs(((f - e) + 180) % 360 - 180) < 0.01 for e, f in _finals(pid) if e is not None)
        assert client.post(f"/api/projects/{pid}/redo").status_code == 200
        assert client.get(f"/api/projects/{pid}").json()["heading_source"] == "track"
        assert client.put(f"/api/projects/{pid}/headings/source", json={"source": "x"}).status_code == 422

        # no GPSImgDirection: computed from the track
        pid2 = client.post("/api/projects", json={"name": "Trace"}).json()["id"]
        client.post(f"/api/projects/{pid2}/import", json={"paths": [str(flat_track_samples)]})
        wait_jobs(client, pid2)
        p = client.get(f"/api/projects/{pid2}").json()
        assert p["heading_source"] == "track" and p["device_headings"] == 0 and p["headings"]["computed"] > 0
