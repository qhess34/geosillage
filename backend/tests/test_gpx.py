from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app import db, main
from app.core import geo, gpx

from .test_import import wait_jobs
from .test_osm import fwd


def gpx_text(segments) -> str:
    """segments: [[(utc, lat, lon)…]…]"""
    segs = "".join(
        "<trkseg>"
        + "".join(
            f'<trkpt lat="{lat}" lon="{lon}"><time>{datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}</time></trkpt>'
            for t, lat, lon in seg
        )
        + "</trkseg>"
        for seg in segments
    )
    return f'<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>t</name>{segs}</trk></gpx>'


def test_parse_segments_gaps_and_untimed_points():
    seg = [(1000 + i, 43.6 + i * 1e-4, 3.87) for i in range(5)]
    later = [(5000 + i, 43.7 + i * 1e-4, 3.88) for i in range(3)]
    text = gpx_text([seg + later]).replace("</trkseg>", '<trkpt lat="43.8" lon="3.9"></trkpt></trkseg>')
    runs = gpx.parse(text.encode(), gap_s=30)
    assert [len(r) for r in runs] == [5, 3]  # split at the time gap, the point without a time is skipped
    assert runs[0][0] == pytest.approx((1000, 43.6, 3.87))
    with pytest.raises(gpx.GpxError):
        gpx.parse(b'<gpx><rte><rtept lat="1" lon="2"/></rte></gpx>')
    with pytest.raises(gpx.GpxError):
        gpx.parse(b"pas du xml")


def test_snap_moves_onto_the_line_within_reach():
    line = [(i, *fwd(43.6, 3.87, 90, i * 10.0)) for i in range(30)]  # 290 m eastwards
    near = fwd(*fwd(43.6, 3.87, 90, 55.0), 0, 6.0)  # 6 m north of the line
    far = fwd(*fwd(43.6, 3.87, 90, 55.0), 0, 80.0)
    res = gpx.snap([{"id": 1, "lat": near[0], "lon": near[1]}, {"id": 2, "lat": far[0], "lon": far[1]}], [line], 30)
    assert set(res) == {1}
    lat, lon, d = res[1]
    assert d == pytest.approx(6.0, abs=0.1)
    on = fwd(43.6, 3.87, 90, 55.0)
    assert geo.distance(lat, lon, on[0], on[1]) < 0.2


@pytest.fixture()
def project(samples, tmp_path):
    with TestClient(main.app) as client:
        pid = client.post("/api/projects", json={"name": "GPX"}).json()["id"]
        client.post(f"/api/projects/{pid}/import", json={"paths": [str(samples)]})
        wait_jobs(client, pid)
        f = client.get(f"/api/projects/{pid}/photos").json()
        rows = [dict(zip(f["fields"], r)) for r in f["rows"]]
        yield client, pid, rows, tmp_path


def _write_gpx(rows, tmp_path, shift_s=0.0, north_m=0.0):
    """A GPX 'recorded' along the photos (true UTC = photo clock - shift_s), offset north_m to the north."""
    pts = [(r["ts"] - shift_s, *fwd(r["lat_orig"], r["lon_orig"], 0, north_m)) for r in rows if r["flags"] == 0 and r["lat_orig"] is not None]
    path = tmp_path / "trace.gpx"
    path.write_text(gpx_text([pts]))
    return path


def test_import_becomes_the_sync_reference(project):
    client, pid, rows, tmp = project
    path = _write_gpx(rows, tmp)
    g = client.post(f"/api/projects/{pid}/gpx", json={"path": str(path)}).json()["gpx"]
    assert g["name"] == "trace.gpx" and g["in_use"] and g["shift_from"] == "positions" and g["shift_s"] == 0
    assert g["covered"] >= len(rows) - 5
    tr = client.get(f"/api/projects/{pid}/track").json()
    assert tr["source"] == "gpx" and sum(len(r) for r in tr["runs"]) == g["points"]
    # back to the camera track, then forgotten
    assert client.patch(f"/api/projects/{pid}/gpx", json={"in_use": False}).json()["gpx"]["in_use"] is False
    assert client.get(f"/api/projects/{pid}/track").json()["source"] == "camera"
    client.delete(f"/api/projects/{pid}/gpx")
    assert client.get(f"/api/projects/{pid}/gpx").json()["gpx"] is None
    assert client.post(f"/api/projects/{pid}/gpx", json={"path": str(tmp / "absent.gpx")}).status_code == 400


def test_time_zone_found_from_positions(project):
    # camera clock 2 h ahead of UTC (summer time): found from the positions, even when the GPS time says otherwise
    client, pid, rows, tmp = project
    path = _write_gpx(rows, tmp, shift_s=7200)
    g = client.post(f"/api/projects/{pid}/gpx", json={"path": str(path)}).json()["gpx"]
    assert g["shift_from"] == "positions" and g["shift_s"] == 7200 and g["covered"] >= len(rows) - 5


def test_time_zone_from_gps_time_when_positions_do_not_match(project):
    # GPX of another place (no match by position): the photos' GPS time gives the shift (here camera clock = UTC)
    client, pid, rows, tmp = project
    far = [dict(r, lat_orig=r["lat_orig"] + 1 if r["lat_orig"] is not None else None) for r in rows]
    path = _write_gpx(far, tmp)
    g = client.post(f"/api/projects/{pid}/gpx", json={"path": str(path)}).json()["gpx"]
    assert g["shift_from"] == "gps" and g["shift_s"] == 0


def test_snap_range_onto_gpx_and_undo(project):
    client, pid, rows, tmp = project
    path = _write_gpx(rows, tmp, north_m=5.0)
    client.post(f"/api/projects/{pid}/gpx", json={"path": str(path)})
    good = [r for r in rows if r["flags"] == 0]
    a, b = good[10]["idx"], good[40]["idx"]
    pre = client.post(f"/api/projects/{pid}/gpx/snap", json={"start_idx": a, "end_idx": b, "preview": True}).json()
    assert pre["moved"] >= 25 and len(pre["moves"]) == pre["moved"] and "undo" not in pre
    assert client.get(f"/api/projects/{pid}/photos/{good[20]['id']}").json()["pos_method"] is None  # nothing changed
    res = client.post(f"/api/projects/{pid}/gpx/snap", json={"start_idx": a, "end_idx": b}).json()
    assert res["moved"] >= 25 and res["max_m"] < 30
    d = client.get(f"/api/projects/{pid}/photos/{good[20]['id']}").json()
    assert d["pos_method"] == "gpx"
    assert geo.distance(d["lat_orig"], d["lon_orig"], d["lat"], d["lon"]) <= 5.5
    client.post(f"/api/projects/{pid}/undo")
    assert client.get(f"/api/projects/{pid}/photos/{good[20]['id']}").json()["pos_method"] is None
