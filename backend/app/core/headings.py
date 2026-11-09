"""Heading (camera direction) computation from the trajectory.

The heading of a photo is the azimuth towards the first following position at least `min_m` away,
looked for within `window_s` seconds and never across a capture interruption. At the end of a run the
previous position is used instead. When the rider is stopped (no position far enough on either side within
the window), the photo takes the direction of arrival at the stop (from the last position at least `min_m`
away before it, in the same run), else the direction of departure: state `stop`. Only a run where the
camera never moves is left uncertain.

Final heading = manual heading if set, else (computed heading + offset of the photo) mod 360.

Source of the automatic heading (meta `heading_source`, one choice for the whole project, undoable):
`track` = computed from the trajectory (above), `device` = the camera's own GPSImgDirection (compass), used when
present, non-zero and varying along the ride (`detect_source`); photos without it fall back to the trajectory.
"""

from dataclasses import dataclass

from .. import db
from . import geo

OK, UNCERTAIN, MISSING, STOP = "ok", "uncertain", "missing", "stop"
TRACK, DEVICE = "track", "device"  # source of the automatic heading

# Positions that must not be used as trajectory points
UNUSABLE = db.NO_GPS | db.INVALID_COORD | db.GPS_JUMP | db.DUPLICATE | db.NO_DATE | db.UNREADABLE


@dataclass
class Pt:
    id: int
    ts: float | None
    lat: float | None
    lon: float | None
    flags: int


def norm(deg: float) -> float:
    return deg % 360.0


def compute(points: list[Pt], min_m: float = 5.0, window_s: float = 12.0) -> dict[int, tuple[float | None, str]]:
    """points in chronological order -> {id: (heading or None, state)}."""
    out: dict[int, tuple[float | None, str]] = {}
    # Split into runs of usable points, cut at capture interruptions
    runs: list[list[Pt]] = []
    cur: list[Pt] = []
    for p in points:
        if p.flags & UNUSABLE or p.lat is None or p.lon is None or p.ts is None:
            out[p.id] = (None, MISSING)
            continue
        if p.flags & db.GAP_BEFORE and cur:
            runs.append(cur)
            cur = []
        cur.append(p)
    if cur:
        runs.append(cur)

    for run in runs:
        n = len(run)
        for i, p in enumerate(run):
            heading = None
            j = i + 1
            while j < n and run[j].ts - p.ts <= window_s:
                if geo.distance(p.lat, p.lon, run[j].lat, run[j].lon) >= min_m:
                    heading = geo.azimuth(p.lat, p.lon, run[j].lat, run[j].lon)
                    break
                j += 1
            if heading is None and (j >= n):
                # End of run: look backwards (direction of arrival)
                k = i - 1
                while k >= 0 and p.ts - run[k].ts <= window_s:
                    if geo.distance(run[k].lat, run[k].lon, p.lat, p.lon) >= min_m:
                        heading = geo.azimuth(run[k].lat, run[k].lon, p.lat, p.lon)
                        break
                    k -= 1
            out[p.id] = (round(heading, 2), OK) if heading is not None else (None, UNCERTAIN)
        # stopped photos: direction of arrival at the stop, else of departure (no time limit, same run)
        for i, p in enumerate(run):
            if out[p.id][1] != UNCERTAIN:
                continue
            k = next((k for k in range(i - 1, -1, -1) if geo.distance(run[k].lat, run[k].lon, p.lat, p.lon) >= min_m), None)
            if k is not None:
                out[p.id] = (round(geo.azimuth(run[k].lat, run[k].lon, p.lat, p.lon), 2), STOP)
                continue
            j = next((j for j in range(i + 1, n) if geo.distance(p.lat, p.lon, run[j].lat, run[j].lon) >= min_m), None)
            if j is not None:
                out[p.id] = (round(geo.azimuth(p.lat, p.lon, run[j].lat, run[j].lon), 2), STOP)
    return out


def final_heading(manual, auto, offset) -> float | None:
    if manual is not None:
        return norm(manual)
    if auto is None:
        return None
    return round(norm(auto + (offset or 0.0)), 2)


# SQLite's % works on integers: normalise explicitly (auto in [0, 360), offset in [-180, 180))
_SUM = "(p.heading_auto + COALESCE(p.heading_offset, 0))"  # offset of the photo (whole ride or a series)
FINAL_SQL = f"""CASE WHEN p.heading_manual IS NOT NULL THEN p.heading_manual
    WHEN p.heading_auto IS NOT NULL THEN ROUND(CASE WHEN {_SUM} < 0 THEN {_SUM} + 360
        WHEN {_SUM} >= 360 THEN {_SUM} - 360 ELSE {_SUM} END, 2)
    END"""


def get_source(conn) -> str:
    return db.get_meta(conn, "heading_source") or TRACK


def device_usable(values: list[float | None]) -> bool:
    """The camera's headings can be trusted: present on most photos, not all 0, and varying (not a constant)."""
    v = [round(x % 360.0) % 360 for x in values if x is not None]
    return bool(values) and len(v) * 2 >= len(values) and any(v) and len(set(v)) > 1


def detect_source(conn) -> str:
    return DEVICE if device_usable([r[0] for r in conn.execute("SELECT heading_exif FROM photo")]) else TRACK


def written(heading: float | None, yaw: float | None, is_360, source: str) -> float | None:
    """GPSImgDirection to write. 360°: the direction of travel (the yaw goes to XMP-GPano). Flat picture: the
    direction of the camera = heading + yaw (camera turned backwards / sideways), except with the camera's
    own compass, which already gives it."""
    if heading is None or is_360 or source == DEVICE or not yaw:
        return heading
    return round(norm(heading + yaw), 2) % 360.0


def recompute(conn, mark_stale_ids: set[int] | None = None) -> None:
    """Recompute automatic headings for the whole project (manual headings are never touched).

    mark_stale_ids: photos whose position changed; manual headings within 3 photos get `heading_stale`.
    """
    s = db.get_settings(conn)
    rows = conn.execute(
        f"SELECT p.id, p.ts, COALESCE(p.lat, p.lat_orig), COALESCE(p.lon, p.lon_orig), {db.EFF_FLAGS_SQL} FROM photo p ORDER BY p.idx"
    ).fetchall()
    pts = [Pt(*r) for r in rows]
    res = compute(pts, s["heading_min_m"], s["heading_window_s"])
    if get_source(conn) == DEVICE:
        for pid, h in conn.execute("SELECT id, heading_exif FROM photo WHERE heading_exif IS NOT NULL"):
            res[pid] = (round(norm(h), 2) % 360.0, OK)
    stale = []
    if mark_stale_ids:
        order = [p.id for p in pts]
        pos = {pid: i for i, pid in enumerate(order)}
        near = {order[j] for i in (pos[x] for x in mark_stale_ids if x in pos) for j in range(max(0, i - 3), min(len(order), i + 4))}
        stale = list(near)
    with db.transaction(conn):
        conn.executemany(
            "UPDATE photo SET heading_auto=?, heading_auto_state=? WHERE id=?",
            [(h, st, pid) for pid, (h, st) in res.items()],
        )
        if stale:
            conn.executemany(
                "UPDATE photo SET heading_stale=1 WHERE id=? AND heading_manual IS NOT NULL", [(i,) for i in stale]
            )


def stats(conn, sequence_id=None) -> dict:
    where, args = ("WHERE p.sequence_id = ?", (sequence_id,)) if sequence_id is not None else ("", ())
    r = conn.execute(
        f"""SELECT COUNT(*) total,
            SUM(p.heading_manual IS NOT NULL) manual,
            SUM(p.heading_manual IS NULL AND p.heading_auto IS NOT NULL) computed,
            SUM(p.heading_manual IS NULL AND p.heading_auto_state = 'uncertain') uncertain,
            SUM(p.heading_manual IS NULL AND (p.heading_auto_state IS NULL OR p.heading_auto_state = 'missing')) missing,
            SUM(p.heading_stale) stale
        FROM photo p {where}""",
        args,
    ).fetchone()
    d = {k: (r[k] or 0) for k in r.keys()}
    d["with_heading_pct"] = round(100 * (d["manual"] + d["computed"]) / d["total"], 1) if d["total"] else 0.0
    return d
