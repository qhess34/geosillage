"""Snapping photo positions onto OpenStreetMap ways (roads, cycle paths, tracks…).

1. `fetch_ways`: ways of the selection's bounding box, from Overpass (cached per project, table osm_cache).
2. `match`: for each photo, the ways within `max_dist`; the most likely sequence of ways along the ride is chosen
   by dynamic programming (cost = distance to the way + penalty for changing way, smaller when the two ways touch).
   The selection is cut into segments: `clear` (one way clearly closest), `ambiguous` (several ways at a similar
   distance, e.g. a cycle path along a road: the user chooses), `none` (no way close enough).
3. `project`: position of a photo projected onto a chosen way.
Pure computations work on a local flat projection (metres), fine for a few kilometres.
"""

import json
import math
import os
import time
import urllib.parse
import urllib.request

from .. import db

# Overpass server (PSS_OVERPASS_URL: another instance or a mirror)
OVERPASS_URL = os.environ.get("PSS_OVERPASS_URL") or "https://overpass-api.de/api/interpreter"
# Every highway way can be travelled (gravel / mountain bike: any track or path, on foot, by car): only the ways
# that are not travelled (planned, gone, platforms, lifts, indoor corridors, service areas) are left out
NOT_TRAVELLED = "proposed|abandoned|razed|disused|dismantled|platform|elevator|corridor|rest_area|services|bus_stop"
CACHE_VERSION = "2"  # changes when the query does (cached responses of an older query are fetched again)
# Overpass refuses anonymous clients (406): identify the application, with a contact link
USER_AGENT = "PanoramaxSequenceStudio/1.0 (+https://github.com/qhess34/panoramax-preprocess)"
MAX_DIST_M = 15.0
AMBIGUOUS_M = 3.0  # second-best way within this margin of the best one: ambiguous
SWITCH_TOUCHING_M = 4.0  # cost of changing way at a shared node (intersection)
SWITCH_OTHER_M = 25.0  # cost of jumping to a way that does not touch the previous one
GRID = 0.002  # bounding boxes rounded outwards to this grid (cache hits for nearby selections)
R = 6371008.8


class OsmError(Exception):
    pass


# ---- Data ----


def bbox_of(points: list[tuple[float, float]], margin_m: float = 50.0) -> tuple[float, float, float, float]:
    """(south, west, north, east) around the points, with a margin, rounded outwards to GRID."""
    lats, lons = [p[0] for p in points], [p[1] for p in points]
    dlat = margin_m / R * 180 / math.pi
    dlon = dlat / max(0.1, math.cos(math.radians(sum(lats) / len(lats))))
    s, w, n, e = min(lats) - dlat, min(lons) - dlon, max(lats) + dlat, max(lons) + dlon
    return (math.floor(s / GRID) * GRID, math.floor(w / GRID) * GRID, math.ceil(n / GRID) * GRID, math.ceil(e / GRID) * GRID)


def overpass_query(bbox) -> str:
    s, w, n, e = bbox
    return f'[out:json][timeout:60];way["highway"]["highway"!~"^({NOT_TRAVELLED})$"]({s:.4f},{w:.4f},{n:.4f},{e:.4f});out geom tags;'


def parse_overpass(data: dict) -> list[dict]:
    ways = []
    for el in data.get("elements", []):
        if el.get("type") != "way" or not el.get("geometry"):
            continue
        tags = el.get("tags", {})
        ways.append(
            {
                "id": el["id"],
                "name": tags.get("name") or tags.get("ref") or "",
                "highway": tags.get("highway", ""),
                "nodes": el.get("nodes", []),
                "coords": [(g["lat"], g["lon"]) for g in el["geometry"]],
            }
        )
    return ways


def fetch_ways(conn, bbox, fetch=None) -> list[dict]:
    """Ways of the bounding box: from the project cache, otherwise from Overpass (fetch: replaceable for tests)."""
    key = f"v{CACHE_VERSION}:" + ",".join(f"{v:.4f}" for v in bbox)
    row = conn.execute("SELECT data FROM osm_cache WHERE bbox=?", (key,)).fetchone()
    if row:
        return parse_overpass(json.loads(row["data"]))
    data = (fetch or _overpass)(overpass_query(bbox))
    conn.execute("INSERT OR REPLACE INTO osm_cache(bbox, fetched_at, data) VALUES(?, ?, ?)", (key, time.time(), json.dumps(data)))
    return parse_overpass(data)


def _overpass(query: str) -> dict:
    body = urllib.parse.urlencode({"data": query}).encode()
    req = urllib.request.Request(OVERPASS_URL, data=body, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    last = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.load(r)
        except Exception as e:  # network errors, 429 / 504 from a busy server
            last = e
            time.sleep(2 * (attempt + 1))
    raise OsmError(f"OpenStreetMap (Overpass) injoignable : {last}")


# ---- Geometry (local flat projection, metres) ----


class Frame:
    def __init__(self, lat0: float, lon0: float):
        self.lat0, self.lon0, self.k = lat0, lon0, math.cos(math.radians(lat0))

    def xy(self, lat, lon):
        return (math.radians(lon - self.lon0) * self.k * R, math.radians(lat - self.lat0) * R)

    def latlon(self, x, y):
        return (self.lat0 + math.degrees(y / R), self.lon0 + math.degrees(x / (R * self.k)))


def _project_xy(px, py, line):
    """Closest point of a polyline [(x, y)…] to (px, py): (distance, x, y)."""
    best = (math.inf, px, py)
    for (ax, ay), (bx, by) in zip(line, line[1:]):
        dx, dy = bx - ax, by - ay
        L = dx * dx + dy * dy
        t = 0.0 if L == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L))
        qx, qy = ax + t * dx, ay + t * dy
        d = math.hypot(px - qx, py - qy)
        if d < best[0]:
            best = (d, qx, qy)
    return best


# ---- Matching ----


def match(photos: list[dict], ways: list[dict], max_dist: float = MAX_DIST_M) -> dict:
    """photos: [{id, idx, lat, lon}] in ride order. Returns {segments, projections, ways}:
    projections[photo_id][way_id] = [lat, lon, dist] for each candidate way; ways: candidate ways (for display)."""
    if not photos:
        return {"segments": [], "projections": {}, "ways": []}
    frame = Frame(photos[0]["lat"], photos[0]["lon"])
    lines = {w["id"]: [frame.xy(*c) for c in w["coords"]] for w in ways}
    nodes = {w["id"]: set(w["nodes"]) for w in ways}
    byid = {w["id"]: w for w in ways}
    cands: list[dict[int, tuple]] = []
    for p in photos:
        px, py = frame.xy(p["lat"], p["lon"])
        c = {}
        for wid, line in lines.items():
            d, qx, qy = _project_xy(px, py, line)
            if d <= max_dist:
                c[wid] = (d, *frame.latlon(qx, qy))
        cands.append(c)

    def switch(a, b):
        if a is None or b is None or a == b:
            return 0.0
        return SWITCH_TOUCHING_M if nodes[a] & nodes[b] else SWITCH_OTHER_M

    # Viterbi over the candidate ways (None = no way: cost max_dist)
    prev = {w: c[0] for w, c in cands[0].items()} or {None: max_dist}
    back: list[dict] = []
    for c in cands[1:]:
        states = {w: v[0] for w, v in c.items()} or {None: max_dist}
        cur, ptr = {}, {}
        for s, cost in states.items():
            best = min(prev, key=lambda q: prev[q] + switch(q, s))
            cur[s], ptr[s] = prev[best] + switch(best, s) + cost, best
        back.append(ptr)
        prev = cur
    path = [min(prev, key=prev.get)]
    for ptr in reversed(back):
        path.append(ptr[path[-1]])
    path.reverse()

    # Segments of consecutive photos on the same way; ambiguity measured over the segment
    segments, start = [], 0
    for i in range(1, len(photos) + 1):
        if i < len(photos) and path[i] == path[start]:
            continue
        idxs = range(start, i)
        way = path[start]
        if way is None:
            segments.append({"start_idx": photos[start]["idx"], "end_idx": photos[i - 1]["idx"], "count": len(idxs), "status": "none", "way_id": None, "candidates": []})
        else:
            mean = {}
            for wid in set().union(*(cands[k].keys() for k in idxs)):
                ds = [cands[k][wid][0] if wid in cands[k] else max_dist for k in idxs]
                mean[wid] = sum(ds) / len(ds)
            order = sorted(mean, key=mean.get)
            near = [w for w in order if mean[w] - mean[order[0]] <= AMBIGUOUS_M]
            status = "ambiguous" if len(near) > 1 else "clear"
            listed = near if status == "ambiguous" else [way]
            segments.append(
                {
                    "start_idx": photos[start]["idx"],
                    "end_idx": photos[i - 1]["idx"],
                    "count": len(idxs),
                    "status": status,
                    "way_id": way if status == "clear" else None,
                    "candidates": [
                        {"id": w, "name": byid[w]["name"], "highway": byid[w]["highway"], "mean_dist": round(mean[w], 1)} for w in listed
                    ],
                }
            )
        start = i
    used = {c["id"] for s in segments for c in s["candidates"]}
    return {
        "segments": segments,
        "projections": {p["id"]: {w: [v[1], v[2], round(v[0], 2)] for w, v in c.items()} for p, c in zip(photos, cands)},
        "ways": [{"id": w["id"], "name": w["name"], "highway": w["highway"], "coords": w["coords"]} for w in ways if w["id"] in used],
    }
