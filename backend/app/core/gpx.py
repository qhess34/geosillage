"""GPX track imported by the user (bike computer, phone…), used in two ways:

1. as the reference track of the time synchronisation (instead of the camera's own GPS): a photo is placed where
   the GPX was at its capture time + the offset (timesync);
2. geometric snapping: photos of a range are moved onto the closest point of the GPX line, whatever the time.

Clocks: photo times are the camera's wall-clock time stored as if it were UTC (exif.reader); GPX times are real
UTC. The difference (time zone, plus the camera's clock error) is detected on import and stored as `shift_s`:
GPX time in the photo clock = UTC time + shift_s. The remaining delay (a few seconds) is the sync offset, set in
the Synchro tab as for the camera track.
"""

import math
import statistics
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

from .. import db
from . import geo
from .osm import Frame, _project_xy

META = "gpx"  # {name, path, imported_at, runs (UTC), shift_s, shift_from}
SOURCE = "track_source"  # "camera" (default) or "gpx"
MAX_FILE_BYTES = 50 * 1024 * 1024
SNAP_MAX_DIST_M = 30.0


class GpxError(Exception):
    pass


def _utc(text: str | None) -> float | None:
    if not text:
        return None
    t = text.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(t)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def parse(data: bytes, gap_s: float = 30.0) -> list[list[tuple[float, float, float]]]:
    """Runs of (utc, lat, lon) in time order, split at track segments and at time gaps longer than gap_s.
    Points without a time are skipped (no use for a time synchronisation)."""
    try:
        root = ET.fromstring(data)
    except ET.ParseError as e:
        raise GpxError(f"Fichier GPX illisible : {e}")
    segs = [el for el in root.iter() if el.tag.split("}")[-1] in ("trkseg", "rte")]
    runs: list[list[tuple[float, float, float]]] = []
    for seg in segs:
        cur: list[tuple[float, float, float]] = []
        for pt in seg:
            if pt.tag.split("}")[-1] not in ("trkpt", "rtept"):
                continue
            try:
                lat, lon = float(pt.get("lat")), float(pt.get("lon"))
            except (TypeError, ValueError):
                continue
            t = next((_utc(c.text) for c in pt if c.tag.split("}")[-1] == "time"), None)
            if t is None or not geo.valid_coord(lat, lon):
                continue
            if cur and t <= cur[-1][0]:
                continue
            if cur and t - cur[-1][0] > gap_s:
                runs.append(cur)
                cur = []
            cur.append((t, lat, lon))
        if cur:
            runs.append(cur)
    runs = [r for r in runs if len(r) >= 2]
    if not runs:
        raise GpxError("Aucun point horodaté dans ce fichier GPX (une trace enregistrée est nécessaire, pas un itinéraire)")
    return runs


def _position(runs, t):
    for run in runs:
        if run[0][0] <= t <= run[-1][0]:
            lo, hi = 0, len(run) - 1
            while hi - lo > 1:
                mid = (lo + hi) // 2
                if run[mid][0] <= t:
                    lo = mid
                else:
                    hi = mid
            a, b = run[lo], run[hi]
            f = 0.0 if b[0] == a[0] else (t - a[0]) / (b[0] - a[0])
            return a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f
    return None


def detect_shift(conn, runs) -> tuple[float, str]:
    """Photo clock - UTC, in seconds. First the shift (in quarters of an hour, up to ±14 h) bringing the GPX closest
    to the camera's own positions: it checks this very GPX against the photos; else the photos' GPS time (camera
    clock - GPS time); else 0."""
    rows = conn.execute("SELECT ts, gps_ts, lat_orig, lon_orig, flags FROM photo WHERE excluded = 0 AND ts IS NOT NULL ORDER BY idx").fetchall()
    pts = [(r["ts"], r["lat_orig"], r["lon_orig"]) for r in rows if geo.valid_coord(r["lat_orig"], r["lon_orig"]) and not r["flags"] & db.GPS_JUMP]
    if pts:
        sample = pts[:: max(1, len(pts) // 200)]
        best = (math.inf, 0.0)
        for q in range(-56, 57):  # quarters of an hour
            shift = q * 900.0
            d = []
            for ts, lat, lon in sample:
                p = _position(runs, ts - shift)
                if p:
                    d.append(geo.distance(lat, lon, p[0], p[1]))
            if len(d) >= max(3, len(sample) // 4):
                m = statistics.median(d)
                if m < best[0]:
                    best = (m, shift)
        if best[0] < 200:  # the camera and the GPX tell the same ride (GPS noise and delay: tens of metres at most)
            return best[1], "positions"
    diffs = [r["ts"] - r["gps_ts"] for r in rows if r["gps_ts"] is not None]
    if len(diffs) >= 3:
        return round(statistics.median(diffs) / 900) * 900, "gps"
    return 0.0, "none"


def store(conn, name: str, path: str, runs) -> dict:
    shift, how = detect_shift(conn, runs)
    db.set_meta(conn, META, {"name": name, "path": path, "imported_at": time.time(), "runs": runs, "shift_s": shift, "shift_from": how})
    db.set_meta(conn, SOURCE, "gpx")
    return summary(conn)


def load(conn) -> dict | None:
    return db.get_meta(conn, META)


def track(conn):
    """GPX runs in the photo clock [(ts, lat, lon)…], or None when no GPX is imported."""
    g = load(conn)
    if not g:
        return None
    s = g.get("shift_s") or 0.0
    return [[(t + s, lat, lon) for t, lat, lon in run] for run in g["runs"]]


def use_gpx(conn) -> bool:
    return db.get_meta(conn, SOURCE) == "gpx" and load(conn) is not None


def summary(conn) -> dict | None:
    g = load(conn)
    if not g:
        return None
    tr = track(conn)
    start, end = min(r[0][0] for r in tr), max(r[-1][0] for r in tr)
    ts = [r[0] for r in conn.execute("SELECT ts FROM photo WHERE excluded = 0 AND ts IS NOT NULL")]
    covered = sum(1 for t in ts if any(r[0][0] <= t <= r[-1][0] for r in tr))
    return {
        "name": g["name"],
        "points": sum(len(r) for r in g["runs"]),
        "runs": len(g["runs"]),
        "start": start,
        "end": end,
        "length_m": round(sum(geo.path_length([(p[1], p[2]) for p in r]) for r in g["runs"])),
        "shift_s": g.get("shift_s") or 0.0,
        "shift_from": g.get("shift_from"),
        "photos": len(ts),
        "covered": covered,
        "in_use": use_gpx(conn),
    }


def snap(points: list[dict], runs, max_dist: float = SNAP_MAX_DIST_M) -> dict[int, tuple[float, float, float]]:
    """points: [{id, lat, lon}] -> {id: (lat, lon, distance)} for the photos within max_dist of the GPX line
    (closest point of any run, whatever the time)."""
    if not points:
        return {}
    fr = Frame(points[0]["lat"], points[0]["lon"])
    xy = [fr.xy(p["lat"], p["lon"]) for p in points]
    m = max_dist + 1.0
    X0, Y0 = min(x for x, _ in xy) - m, min(y for _, y in xy) - m
    X1, Y1 = max(x for x, _ in xy) + m, max(y for _, y in xy) + m
    # only the pieces of the GPX near the photos (a long ride has thousands of points): a segment is kept when one
    # of its ends is in the box around the photos, or when it crosses it (both ends outside, long segment)
    lines: list[list[tuple[float, float]]] = []
    for run in runs:
        pts = [fr.xy(lat, lon) for _, lat, lon in run]
        cur: list[tuple[float, float]] = []
        for a, b in zip(pts, pts[1:]):
            near = (X0 <= a[0] <= X1 and Y0 <= a[1] <= Y1) or (X0 <= b[0] <= X1 and Y0 <= b[1] <= Y1) or not (
                max(a[0], b[0]) < X0 or min(a[0], b[0]) > X1 or max(a[1], b[1]) < Y0 or min(a[1], b[1]) > Y1
            )
            if near:
                if not cur:
                    cur.append(a)
                cur.append(b)
            elif cur:
                lines.append(cur)
                cur = []
        if cur:
            lines.append(cur)
    boxes = [(min(x for x, _ in ln), min(y for _, y in ln), max(x for x, _ in ln), max(y for _, y in ln)) for ln in lines]
    out = {}
    for p in points:
        px, py = fr.xy(p["lat"], p["lon"])
        best = (math.inf, px, py)
        for ln, (x0, y0, x1, y1) in zip(lines, boxes):
            if px < x0 - max_dist or px > x1 + max_dist or py < y0 - max_dist or py > y1 + max_dist:
                continue
            r = _project_xy(px, py, ln)
            if r[0] < best[0]:
                best = r
        if best[0] <= max_dist:
            lat, lon = fr.latlon(best[1], best[2])
            out[p["id"]] = (lat, lon, best[0])
    return out
