import pytest

from app import db
from app.core import analysis, geo
from app.core.analysis import P
from app.exif.reader import parse_datetime

SETTINGS = {"gap_seconds": 10.0, "jump_speed_ms": 20.0, "jump_min_m": 25.0}


def test_azimuth_cardinal():
    assert geo.azimuth(43.6, 3.87, 43.61, 3.87) == pytest.approx(0.0, abs=1e-6)
    assert geo.azimuth(43.6, 3.87, 43.6, 3.88) == pytest.approx(90.0, abs=0.01)
    assert geo.azimuth(43.6, 3.87, 43.59, 3.87) == pytest.approx(180.0, abs=1e-6)
    assert geo.azimuth(43.6, 3.87, 43.6, 3.86) == pytest.approx(270.0, abs=0.01)


def test_distance():
    # 0.001° of latitude ≈ 111 m
    assert geo.distance(43.6, 3.87, 43.601, 3.87) == pytest.approx(111.1, abs=0.5)
    assert geo.path_length([(43.6, 3.87), (43.601, 3.87), (43.602, 3.87)]) == pytest.approx(222.2, abs=1)


@pytest.mark.parametrize(
    "lat,lon,ok",
    [(43.6, 3.8, True), (None, 3.8, False), (0.0, 0.0, False), (91, 0.1, False), (10, -181, False)],
)
def test_valid_coord(lat, lon, ok):
    assert geo.valid_coord(lat, lon) is ok


def test_parse_datetime():
    assert parse_datetime("2026:06:14 09:30:24")[0] == parse_datetime("2026:06:14 09:30:24")[0]
    a, _ = parse_datetime("2026:06:14 09:30:24")
    b, tz = parse_datetime("2026:06:14 09:30:24.250+02:00")
    assert b - a == pytest.approx(0.25) and tz
    assert parse_datetime("0000:00:00 00:00:00")[0] is None
    assert parse_datetime("garbage")[0] is None


def track(n, step_m=10.0, dt=2.0):
    """Straight northward ride: step_m meters every dt seconds."""
    pts = []
    lat = 43.6
    for i in range(n):
        pts.append(P(i + 1, 1000 + i * dt, lat, 3.87, f"h{i}", 0, f"F{i:04d}.JPG"))
        lat += step_m / 111_120
    return pts


def flags_of(ordered):
    return {p.id: p.flags for p in ordered}


def test_clean_track_has_no_anomaly():
    assert all(f == 0 for f in flags_of(analysis.detect(track(30), SETTINGS)).values())


def test_isolated_jump_flags_only_the_spike():
    pts = track(10)
    pts[4].lon += 0.003  # ~240 m east, then back on track
    f = flags_of(analysis.detect(pts, SETTINGS))
    assert f[5] & db.GPS_JUMP
    assert sum(1 for v in f.values() if v & db.GPS_JUMP) == 1


def test_gap_duplicate_missing_fields():
    pts = track(10)
    for p in pts[5:]:
        p.ts += 300  # 5 minutes interruption before photo 6
    pts[2].qhash = pts[1].qhash
    pts[7].lat = pts[7].lon = None
    pts[8].ts = None
    pts[3].ts = pts[2].ts  # same timestamp as a duplicate: not compared
    f = flags_of(analysis.detect(pts, SETTINGS))
    assert f[6] & db.GAP_BEFORE and not f[6] & db.GPS_JUMP
    assert f[3] & db.DUPLICATE
    assert f[8] & db.NO_GPS
    assert f[9] & db.NO_DATE


def test_order_is_chronological_with_undated_last():
    pts = track(5)
    pts[0].ts, pts[4].ts = pts[4].ts, pts[0].ts
    pts[2].ts = None
    order = [p.id for p in analysis.detect(pts, SETTINGS)]
    assert order == [5, 2, 4, 1, 3]
