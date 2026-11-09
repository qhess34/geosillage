"""Chronological ordering and anomaly detection on imported photos."""

from dataclasses import dataclass

from .. import db
from . import geo

RECOMPUTED = db.NO_GPS | db.NO_DATE | db.DUPLICATE | db.INVALID_COORD | db.GPS_JUMP | db.GAP_BEFORE | db.SAME_TIME


@dataclass
class P:
    id: int
    ts: float | None
    lat: float | None
    lon: float | None
    qhash: str | None
    flags: int
    filename: str
    dup_of: int | None = None


def _is_step(a: P, b: P, settings) -> bool:
    """True when going from a to b requires an implausible displacement."""
    d = geo.distance(a.lat, a.lon, b.lat, b.lon)
    if d < settings["jump_min_m"]:
        return False
    dt = abs((b.ts or 0) - (a.ts or 0))
    return dt <= 0 or d / dt > settings["jump_speed_ms"]


def detect(photos: list[P], settings: dict) -> list[P]:
    """Order photos chronologically and set anomaly flags. Returns the ordered list."""
    by_id = sorted(photos, key=lambda p: p.id)
    first_by_hash: dict[str, int] = {}
    for p in by_id:
        p.flags &= ~RECOMPUTED
        p.dup_of = None
        if p.qhash:
            if p.qhash in first_by_hash:
                p.flags |= db.DUPLICATE
                p.dup_of = first_by_hash[p.qhash]
            else:
                first_by_hash[p.qhash] = p.id
        if p.ts is None:
            p.flags |= db.NO_DATE
        if p.lat is None or p.lon is None:
            p.flags |= db.NO_GPS
        elif not geo.valid_coord(p.lat, p.lon):
            p.flags |= db.INVALID_COORD

    ordered = sorted(photos, key=lambda p: (p.ts is None, p.ts or 0, p.filename, p.id))
    # Only real, dated, readable photos take part in time/position checks
    seq = [p for p in ordered if not p.flags & (db.DUPLICATE | db.NO_DATE | db.UNREADABLE)]

    prev = None
    for p in seq:
        if prev is not None:
            dt = p.ts - prev.ts
            if dt > settings["gap_seconds"]:
                p.flags |= db.GAP_BEFORE
            elif dt == 0:
                p.flags |= db.SAME_TIME
        prev = p

    located = [p for p in seq if not p.flags & (db.NO_GPS | db.INVALID_COORD)]
    last_good = None
    for i, p in enumerate(located):
        if last_good is None:
            last_good = p
            continue
        if _is_step(last_good, p, settings) and not p.flags & db.GAP_BEFORE:
            p.flags |= db.GPS_JUMP
            nxt = located[i + 1] if i + 1 < len(located) else None
            if nxt is not None and not _is_step(last_good, nxt, settings):
                continue  # isolated spike: keep the previous reference position
        last_good = p
    return ordered


def run(conn) -> None:
    """Recompute idx and anomaly flags for the whole project."""
    settings = db.get_settings(conn)
    rows = conn.execute("SELECT id, ts, lat_orig, lon_orig, qhash, flags, filename FROM photo").fetchall()
    photos = [P(r["id"], r["ts"], r["lat_orig"], r["lon_orig"], r["qhash"], r["flags"], r["filename"]) for r in rows]
    ordered = detect(photos, settings)
    with db.transaction(conn):
        conn.executemany(
            "UPDATE photo SET idx=?, flags=?, dup_of=? WHERE id=?",
            [(i, p.flags, p.dup_of, p.id) for i, p in enumerate(ordered)],
        )


def summary(conn) -> dict:
    """Import report."""
    c = lambda sql, *a: conn.execute(sql, a).fetchone()[0]  # noqa: E731
    flag = lambda f: c("SELECT COUNT(*) FROM photo WHERE flags & ? != 0", f)  # noqa: E731
    total = c("SELECT COUNT(*) FROM photo")
    good = conn.execute(
        "SELECT ts, lat_orig, lon_orig FROM photo WHERE flags & ? = 0 ORDER BY idx",
        (db.NO_GPS | db.NO_DATE | db.DUPLICATE | db.INVALID_COORD | db.GPS_JUMP | db.UNREADABLE,),
    ).fetchall()
    ts = conn.execute("SELECT MIN(ts), MAX(ts) FROM photo WHERE flags & ? = 0", (db.DUPLICATE,)).fetchone()
    cams = conn.execute(
        "SELECT make, model, COUNT(*) n FROM photo GROUP BY make, model ORDER BY n DESC"
    ).fetchall()
    from . import quality

    steps = sorted(
        b["ts"] - a["ts"]
        for a, b in zip(good, good[1:])
        if a["ts"] is not None and b["ts"] is not None and b["ts"] > a["ts"]
    )
    median = round(steps[len(steps) // 2], 2) if steps else None  # median interval between photos (s)
    stop_photos = sum(i["count"] for i in quality.check(conn) if i["kind"] == "stop") if total else 0
    gap = db.get_settings(conn)["gap_seconds"]
    return {
        "median_interval_s": median,
        "interval_warning": bool(
            (median is not None and median > gap / 2) or (total and stop_photos > 0.2 * total)
        ),  # photos too sparse for the thresholds (tuned for ~1 photo / 2 s) or very many stops
        "total": total,
        "geolocated": c("SELECT COUNT(*) FROM photo WHERE flags & ? = 0", db.NO_GPS | db.INVALID_COORD),
        "no_gps": flag(db.NO_GPS),
        "no_date": flag(db.NO_DATE),
        "duplicates": flag(db.DUPLICATE),
        "invalid_coords": flag(db.INVALID_COORD),
        "gps_jumps": flag(db.GPS_JUMP),
        "gps_anomalies": flag(db.GPS_JUMP | db.INVALID_COORD),
        "interruptions": flag(db.GAP_BEFORE),
        "same_time": flag(db.SAME_TIME),
        "unreadable": flag(db.UNREADABLE),
        "missing_files": flag(db.MISSING_FILE),
        "excluded": c("SELECT COUNT(*) FROM photo WHERE excluded = 1"),
        "is_360": c("SELECT COUNT(*) FROM photo WHERE is_360 = 1"),
        "start": ts[0],
        "end": ts[1],
        "duration_s": (ts[1] - ts[0]) if ts[0] is not None and ts[1] is not None else None,
        "distance_m": round(geo.path_length([(r["lat_orig"], r["lon_orig"]) for r in good]), 1),
        "thumbs_done": c("SELECT COUNT(*) FROM photo WHERE thumb = 1"),
        "thumbs_failed": c("SELECT COUNT(*) FROM photo WHERE thumb = -1"),
        "cameras": [{"make": r["make"], "model": r["model"], "count": r["n"]} for r in cams],
    }
