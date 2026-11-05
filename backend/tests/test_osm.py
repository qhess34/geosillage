import pytest
from fastapi.testclient import TestClient

from app import db, main
from app.core import geo, osm

from .test_import import wait_jobs

LAT, LON = 43.6, 3.87


def fwd(lat, lon, az, d):
    lon2, lat2, _ = geo.GEOD.fwd(lon, lat, az, d)
    return lat2, lon2


def way(wid, coords, nodes, name="", highway="residential"):
    return {"id": wid, "name": name, "highway": highway, "nodes": nodes, "coords": coords}


def straight(start, az, n, step):
    pts, p = [], start
    for _ in range(n):
        pts.append(p)
        p = fwd(*p, az, step)
    return pts


def photos_along(points, side_az, offset):
    return [{"id": i + 1, "idx": i, "lat": fwd(*p, side_az, offset)[0], "lon": fwd(*p, side_az, offset)[1]} for i, p in enumerate(points)]


def test_single_way_is_clear_and_projection_lands_on_it():
    road = straight((LAT, LON), 90, 12, 10)
    photos = photos_along(road[1:-1], 0, 3.0)  # 3 m north of an east-west road
    res = osm.match(photos, [way(1, [road[0], road[-1]], [1, 2], "Rue A")])
    assert [s["status"] for s in res["segments"]] == ["clear"]
    assert res["segments"][0]["way_id"] == 1 and res["segments"][0]["count"] == len(photos)
    for p in photos:
        lat, lon, d = res["projections"][p["id"]][1]
        assert d == pytest.approx(3.0, abs=0.05)
        assert geo.distance(p["lat"], p["lon"], lat, lon) == pytest.approx(3.0, abs=0.05)


def test_parallel_ways_are_ambiguous():
    road = straight((LAT, LON), 90, 12, 10)
    path = [fwd(*p, 0, 6.0) for p in road]  # cycle path 6 m north of the road
    photos = photos_along(road[1:-1], 0, 2.5)  # in between: 2.5 m from the road, 3.5 m from the path
    res = osm.match(photos, [way(1, [road[0], road[-1]], [1, 2], "Avenue"), way(2, [path[0], path[-1]], [3, 4], "", "cycleway")])
    seg = res["segments"][0]
    assert seg["status"] == "ambiguous" and seg["way_id"] is None
    assert [c["id"] for c in seg["candidates"]] == [1, 2]
    assert seg["candidates"][1]["highway"] == "cycleway"


def test_turn_at_an_intersection_changes_way():
    a = straight((LAT, LON), 90, 6, 10)  # east, then north from the corner
    b = straight(a[-1], 0, 6, 10)
    ways = [way(1, [a[0], a[-1]], [1, 2], "Rue Est"), way(2, [b[0], b[-1]], [2, 3], "Rue Nord")]
    photos = photos_along(a[:-1], 180, 2.0) + photos_along(b[1:], 90, 2.0)
    for i, p in enumerate(photos):
        p["id"], p["idx"] = i + 1, i
    res = osm.match(photos, ways)
    assert [(s["status"], s["way_id"]) for s in res["segments"]] == [("clear", 1), ("clear", 2)]
    assert res["segments"][0]["end_idx"] == len(a) - 2


def test_no_way_close_enough():
    road = straight((LAT, LON), 90, 5, 10)
    photos = photos_along(road, 0, 40.0)
    res = osm.match(photos, [way(1, [road[0], road[-1]], [1, 2])])
    assert [s["status"] for s in res["segments"]] == ["none"] and res["ways"] == []


def test_bbox_rounded_outwards():
    s, w, n, e = osm.bbox_of([(43.6012, 3.8712), (43.6031, 3.8755)])
    assert s <= 43.6012 - 0.0004 and n >= 43.6031 + 0.0004 and w < 3.8712 and e > 3.8755
    assert round(s / osm.GRID, 6) == int(round(s / osm.GRID))


@pytest.fixture()
def project(samples):
    with TestClient(main.app) as client:
        pid = client.post("/api/projects", json={"name": "OSM"}).json()["id"]
        client.post(f"/api/projects/{pid}/import", json={"paths": [str(samples)]})
        wait_jobs(client, pid)
        yield client, pid


def test_snap_api_with_recorded_overpass(project, monkeypatch):
    client, pid = project
    rows = client.get(f"/api/projects/{pid}/photos").json()
    f = rows["fields"]
    good = [dict(zip(f, r)) for r in rows["rows"] if r[f.index("flags")] == 0][:15]
    # A fake "way" following the first photos' positions, offset 4 m to the north
    coords = [fwd(p["lat"], p["lon"], 0, 4.0) for p in good]
    calls = []

    def fake(query):
        calls.append(query)
        return {"elements": [{"type": "way", "id": 99, "tags": {"highway": "cycleway", "name": "Piste"}, "nodes": list(range(len(coords))),
                              "geometry": [{"lat": c[0], "lon": c[1]} for c in coords]}]}

    monkeypatch.setattr(osm, "_overpass", fake)
    a, b = good[1]["idx"], good[-2]["idx"]
    prop = client.post(f"/api/projects/{pid}/osm/snap/propose", json={"start_idx": a, "end_idx": b}).json()
    assert prop["segments"][0]["status"] == "clear" and prop["segments"][0]["way_id"] == 99
    assert 'highway' in calls[0] and prop["ways"][0]["name"] == "Piste"
    res = client.post(f"/api/projects/{pid}/osm/snap/apply", json={"start_idx": a, "end_idx": b, "segments": [{"start_idx": a, "end_idx": b, "way_id": 99}]}).json()
    assert res["moved"] >= 10 and len(calls) == 1  # second call served from the project cache
    d = client.get(f"/api/projects/{pid}/photos/{good[5]['id']}").json()
    assert d["pos_method"] == "osm"
    assert geo.distance(d["lat_orig"], d["lon_orig"], d["lat"], d["lon"]) < 4.5
    with db.open_project(pid) as conn:
        assert conn.execute("SELECT COUNT(*) FROM osm_cache").fetchone()[0] == 1
    client.post(f"/api/projects/{pid}/undo")
    assert client.get(f"/api/projects/{pid}/photos/{good[5]['id']}").json()["pos_method"] is None


def test_snap_api_overpass_unreachable(project, monkeypatch):
    client, pid = project

    def down(query):
        raise osm.OsmError("OpenStreetMap (Overpass) injoignable : test")

    monkeypatch.setattr(osm, "_overpass", down)
    r = client.post(f"/api/projects/{pid}/osm/snap/propose", json={"start_idx": 5, "end_idx": 20})
    assert r.status_code == 502 and "injoignable" in r.json()["detail"]
