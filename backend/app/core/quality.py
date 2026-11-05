"""Points to check before publishing (never acted on automatically: the user chooses, e.g. which photo of a stop
to keep, the first one is not necessarily the best).

- `stop`: several consecutive photos at the same place (red light, pause): keep the best one(s), exclude the others;
- `spacing`: long distance between two consecutive photos (fast, or photos missing);
- `gps_dop`: imprecise GPS fix (dilution of precision written by the camera);
- `heading`: manual heading far from the heading computed from the track (typing error?).
Excluded photos are ignored; GPS jumps and photos without a position are reported elsewhere (anomalies).
"""

from .. import db
from . import geo
from .positions import UNUSABLE, _positioned_sql

STOP_M = 2.0  # displacement between consecutive photos below this: not moving
STOP_MIN = 3  # ...over at least this many photos
SPACING_M = 25.0
DOP_MAX = 5.0
HEADING_DIFF = 90.0

KINDS = ("stop", "spacing", "gps_dop", "heading")


def _run(kind: str, rows: list, detail: str, **extra) -> dict:
    return {"kind": kind, "start_idx": rows[0]["idx"], "end_idx": rows[-1]["idx"], "count": len(rows), "detail": detail, **extra}


def _merge(kind: str, flagged: list, detail) -> list[dict]:
    """Consecutive flagged photos (by index among the usable ones) → one run each."""
    out, cur = [], []
    for pos, r in flagged:
        if cur and pos != cur[-1][0] + 1:
            out.append(_run(kind, [x[1] for x in cur], detail([x[1] for x in cur])))
            cur = []
        cur.append((pos, r))
    if cur:
        out.append(_run(kind, [x[1] for x in cur], detail([x[1] for x in cur])))
    return out


def check(conn) -> list[dict]:
    rows = conn.execute(
        f"""SELECT p.id, p.idx, p.ts, p.flags, p.gps_dop, p.heading_manual, p.heading_auto, p.sequence_id,
                   {_positioned_sql()} AS placed, COALESCE(p.lat, p.lat_orig) lat, COALESCE(p.lon, p.lon_orig) lon
            FROM photo p WHERE p.excluded = 0 AND p.flags & {UNUSABLE} = 0 ORDER BY p.idx"""
    ).fetchall()
    excluded = {r[0] for r in conn.execute("SELECT idx FROM photo WHERE excluded = 1")}
    issues: list[dict] = []

    # Stops and spacing: consecutive positioned photos, not across a capture interruption or a GPS jump
    stop: list = []
    far: list = []

    def close_stop():
        if len(stop) >= STOP_MIN:
            dur = (stop[-1]["ts"] - stop[0]["ts"]) if stop[0]["ts"] is not None and stop[-1]["ts"] is not None else None
            issues.append(_run("stop", stop, f"{len(stop)} photos au même endroit" + (f" pendant {dur:.0f} s" if dur else "")))
        stop.clear()

    prev = None
    for pos, r in enumerate(rows):
        if not r["placed"] or r["flags"] & db.GPS_JUMP:
            close_stop()
            prev = None
            continue
        # photos excluded in between: a hole chosen by the user, not reported
        broken = prev is None or r["flags"] & db.GAP_BEFORE or r["idx"] - prev["idx"] > 1 and any(prev["idx"] < i < r["idx"] for i in excluded)
        d = None if broken else geo.distance(prev["lat"], prev["lon"], r["lat"], r["lon"])
        if d is not None and d < STOP_M:
            if not stop:
                stop.append(prev)
            stop.append(r)
        else:
            close_stop()
        if d is not None and d > SPACING_M:
            issues.append(_run("spacing", [prev, r], f"{d:.0f} m d'écart", meters=round(d)))
        prev = r
    close_stop()

    dop = [(pos, r) for pos, r in enumerate(rows) if r["gps_dop"] is not None and r["gps_dop"] > DOP_MAX]
    issues += _merge("gps_dop", dop, lambda rs: f"précision GPS faible (DOP jusqu'à {max(x['gps_dop'] for x in rs):.1f})")

    def head_diff(r):
        if r["heading_manual"] is None or r["heading_auto"] is None:
            return 0.0
        return abs((r["heading_manual"] - r["heading_auto"] + 180) % 360 - 180)

    heads = [(pos, r) for pos, r in enumerate(rows) if head_diff(r) > HEADING_DIFF]
    issues += _merge("heading", heads, lambda rs: f"cap manuel à plus de {HEADING_DIFF:.0f}° du cap calculé (jusqu'à {max(head_diff(x) for x in rs):.0f}°)")

    issues.sort(key=lambda i: (i["start_idx"], KINDS.index(i["kind"])))
    return issues
