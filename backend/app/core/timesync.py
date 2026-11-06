"""GPS delay correction by time synchronisation along the track.

The GoPro records positions late: the position stored in a photo is where the camera was `delay` seconds
earlier. The *track* is the sequence of recorded positions (original GPS, reliable photos only), indexed
by capture time. Correcting the delay means sliding every photo along this track: the photo taken at time t
is placed where the track is at time t + offset. The photos stay on the itinerary (interpolation between
consecutive recorded points, never a straight line across a turn wider than one GPS step).

The offset is measured by the user: dragging a photo along the track until it matches a feature visible on
the satellite view gives `offset = time at that point of the track - capture time of the photo`.

The track is never interpolated across a capture interruption. Beyond the end of a run, positions are
extrapolated along the last recorded step for at most MAX_EXTRAPOLATION_S seconds.
"""

import bisect
import math

from .. import db
from . import geo, positions

MAX_EXTRAPOLATION_S = 5.0
UNUSABLE = db.NO_GPS | db.INVALID_COORD | db.GPS_JUMP | db.DUPLICATE | db.NO_DATE | db.UNREADABLE


class SyncError(Exception):
    pass


def build_track(conn) -> list[list[tuple[float, float, float]]]:
    """Runs of (ts, lat, lon) from the original GPS of reliable photos, split at capture interruptions."""
    rows = conn.execute("SELECT ts, lat_orig, lon_orig, flags FROM photo ORDER BY idx").fetchall()
    runs: list[list[tuple[float, float, float]]] = []
    cur: list[tuple[float, float, float]] = []
    for ts, lat, lon, flags in rows:
        if flags & db.GAP_BEFORE and cur:
            runs.append(cur)
            cur = []
        if flags & UNUSABLE or ts is None or not geo.valid_coord(lat, lon):
            continue
        if cur and ts <= cur[-1][0]:
            continue  # same timestamp as the previous point: no time information
        cur.append((ts, lat, lon))
    if cur:
        runs.append(cur)
    return [r for r in runs if len(r) >= 2]


def _lerp(a, b, t):
    """Geodesic interpolation between track points a and b at time t (may extrapolate)."""
    f = (t - a[0]) / (b[0] - a[0])
    az, _, d = geo.GEOD.inv(a[2], a[1], b[2], b[1])
    lon, lat, _ = geo.GEOD.fwd(a[2], a[1], az, d * f)
    return lat, lon


def position_at(track, t: float) -> tuple[float, float] | None:
    """Position on the track at time t, or None if t is not covered (in an interruption, or too far)."""
    for run in track:
        start, end = run[0][0], run[-1][0]
        if start - MAX_EXTRAPOLATION_S <= t <= end + MAX_EXTRAPOLATION_S:
            if t <= start:
                return _lerp(run[0], run[1], t)
            if t >= end:
                return _lerp(run[-2], run[-1], t)
            times = [p[0] for p in run]
            i = bisect.bisect_right(times, t) - 1
            return _lerp(run[i], run[i + 1], t)
    return None


def offset_for_point(track, photo_ts: float, lat: float, lon: float, window_s: float = 30.0) -> tuple[float, float, float]:
    """Project (lat, lon) on the part of the track within ±window_s of the photo time.

    Returns (offset_s, snapped_lat, snapped_lon). Uses a local planar projection (fine at this scale).
    """
    best = None
    k = 111_320.0
    coslat = math.cos(math.radians(lat))
    for run in track:
        for a, b in zip(run, run[1:]):
            if b[0] < photo_ts - window_s or a[0] > photo_ts + window_s:
                continue
            ax, ay = (a[2] - lon) * k * coslat, (a[1] - lat) * k
            bx, by = (b[2] - lon) * k * coslat, (b[1] - lat) * k
            dx, dy = bx - ax, by - ay
            l2 = dx * dx + dy * dy
            f = 0.0 if l2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / l2))
            px, py = ax + f * dx, ay + f * dy
            dist = math.hypot(px, py)
            if best is None or dist < best[0]:
                t = a[0] + f * (b[0] - a[0])
                best = (dist, t, a, b, f)
    if best is None:
        raise SyncError("Pas de trace GPS autour de cette photo")
    _, t, a, b, f = best
    slat, slon = _lerp(a, b, t)
    return round(t - photo_ts, 2), slat, slon


def apply(conn, offset_s: float, ids: list[int], keep_manual: bool = True) -> dict:
    """Place photos on the track at (capture time + offset). Manual corrections are kept unless asked."""
    if not ids:
        raise SyncError("Aucune photo")
    track = build_track(conn)
    if not track:
        raise SyncError("Pas de trace GPS exploitable")
    ph = ",".join("?" * len(ids))
    rows = conn.execute(f"SELECT id, ts, pos_method FROM photo WHERE id IN ({ph})", ids).fetchall()
    changed = kept = uncovered = 0
    for r in rows:
        if r["ts"] is None:
            uncovered += 1
            continue
        if keep_manual and r["pos_method"] in positions.MANUAL_METHODS:
            kept += 1
            continue
        pos = position_at(track, r["ts"] + offset_s)
        if pos is None:
            uncovered += 1
            continue
        conn.execute(
            "UPDATE photo SET lat=?, lon=?, pos_method='time', time_offset=? WHERE id=?", (pos[0], pos[1], offset_s, r["id"])
        )
        changed += 1
    return {"changed": changed, "kept_manual": kept, "uncovered": uncovered}


def runs(conn) -> list[dict]:
    """Lots of consecutive photos synchronised with the same offset (the GPS delay may change during a ride:
    e.g. photos 1-100 at +1.0 s, 101-700 at +1.9 s), and the lots not synchronised.

    Photos corrected by hand (dragged, interpolated, snapped…) do not break a lot: they keep their own position
    whatever the offset, and are counted as `manual`. Excluded and unusable photos are skipped."""
    rows = conn.execute(
        f"""SELECT idx, time_offset, pos_method FROM photo
            WHERE excluded = 0 AND flags & {positions.UNUSABLE} = 0 ORDER BY idx"""
    ).fetchall()
    out: list[dict] = []
    cur: dict | None = None
    pending: list = []  # hand-corrected photos waiting to know which lot they belong to: the one that follows

    for r in rows:
        if r["pos_method"] in positions.MANUAL_METHODS:
            pending.append(r)
            continue
        key = round(r["time_offset"], 1) if r["pos_method"] == "time" and r["time_offset"] is not None else None
        if cur is None or cur["offset_s"] != key:
            if cur:
                out.append(cur)
            # a lot starts at the first photo it holds, hand-corrected photos before it included
            cur = {"offset_s": key, "start_idx": (pending[0] if pending else r)["idx"], "end_idx": r["idx"], "count": 0, "manual": 0}
        cur["count"] += len(pending) + 1
        cur["manual"] += len(pending)
        cur["end_idx"] = r["idx"]
        pending = []
    if pending:  # hand-corrected photos at the end: in the last lot (or a lot of their own if there is none)
        if cur is None:
            cur = {"offset_s": None, "start_idx": pending[0]["idx"], "end_idx": pending[-1]["idx"], "count": 0, "manual": 0}
        cur["end_idx"] = pending[-1]["idx"]
        cur["count"] += len(pending)
        cur["manual"] += len(pending)
    if cur:
        out.append(cur)
    return out
