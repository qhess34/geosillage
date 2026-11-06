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

# Thresholds: project settings stop_m, stop_min, spacing_m, dop_max, heading_diff (defaults in config.DEFAULT_SETTINGS,
# set in the Settings dialog)

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


def keep_headings(conn, photo_ids: list[int], keep: bool = True) -> int:
    """« Ignorer » a heading to check: the manual heading is right, the computed one is not (GPS lost…). The manual
    heading is copied to heading_kept (an editable column: in the undo journal); changing it later makes the check
    come back. keep=False: reported again."""
    ph = ",".join("?" * len(photo_ids))
    if keep:
        sql = f"UPDATE photo SET heading_kept = heading_manual WHERE id IN ({ph}) AND heading_manual IS NOT NULL"
    else:
        sql = f"UPDATE photo SET heading_kept = NULL WHERE id IN ({ph}) AND heading_kept IS NOT NULL"
    return conn.execute(sql, photo_ids).rowcount


def check(conn) -> list[dict]:
    st = db.get_settings(conn)
    stop_m, stop_min, spacing_m = st["stop_m"], int(st["stop_min"]), st["spacing_m"]
    dop_max, heading_diff = st["dop_max"], st["heading_diff"]
    rows = conn.execute(
        f"""SELECT p.id, p.idx, p.ts, p.flags, p.gps_dop, p.heading_manual, p.heading_auto, p.heading_kept, p.sequence_id,
                   {_positioned_sql()} AS placed, COALESCE(p.lat, p.lat_orig) lat, COALESCE(p.lon, p.lon_orig) lon
            FROM photo p WHERE p.excluded = 0 AND p.flags & {UNUSABLE} = 0 ORDER BY p.idx"""
    ).fetchall()
    excluded = {r[0] for r in conn.execute("SELECT idx FROM photo WHERE excluded = 1")}
    issues: list[dict] = []

    # Stops and spacing: consecutive positioned photos, not across a capture interruption or a GPS jump
    stop: list = []
    far: list = []

    def close_stop():
        if len(stop) >= stop_min:
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
        if d is not None and d < stop_m:
            if not stop:
                stop.append(prev)
            stop.append(r)
        else:
            close_stop()
        if d is not None and d > spacing_m:
            issues.append(_run("spacing", [prev, r], f"{d:.0f} m d'écart", meters=round(d)))
        prev = r
    close_stop()

    dop = [(pos, r) for pos, r in enumerate(rows) if r["gps_dop"] is not None and r["gps_dop"] > dop_max]
    issues += _merge("gps_dop", dop, lambda rs: f"précision GPS faible (DOP jusqu'à {max(x['gps_dop'] for x in rs):.1f})")

    def head_diff(r):
        if r["heading_manual"] is None or r["heading_auto"] is None:
            return 0.0
        return abs((r["heading_manual"] - r["heading_auto"] + 180) % 360 - 180)

    # headings the user chose to keep (computed heading wrong, e.g. GPS lost): not reported while unchanged
    heads = [(pos, r) for pos, r in enumerate(rows) if head_diff(r) > heading_diff and r["heading_kept"] != r["heading_manual"]]
    issues += _merge("heading", heads, lambda rs: f"cap manuel à plus de {heading_diff:.0f}° du cap calculé (jusqu'à {max(head_diff(x) for x in rs):.0f}°)")

    issues.sort(key=lambda i: (i["start_idx"], KINDS.index(i["kind"])))
    return issues
