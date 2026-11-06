"""Manual position corrections. The original coordinates (lat_orig/lon_orig) are never modified:
the corrected position lives in photo.lat/lon (NULL = original), with photo.pos_method.

All functions must run inside `undo.undoable(...)`; the caller then recomputes headings.
"""

import math

from .. import db
from . import geo


class PositionError(Exception):
    pass


def _current(conn, ids: list[int]) -> list:
    if not ids:
        raise PositionError("Aucune photo sélectionnée")
    ph = ",".join("?" * len(ids))
    return conn.execute(
        f"""SELECT id, COALESCE(lat, lat_orig) lat, COALESCE(lon, lon_orig) lon, heading_auto, flags
            FROM photo WHERE id IN ({ph})""",
        ids,
    ).fetchall()


def set_position(conn, photo_id: int, lat: float, lon: float, method: str = "manual") -> None:
    if not geo.valid_coord(lat, lon):
        raise PositionError("Coordonnées invalides")
    if not conn.execute("SELECT 1 FROM photo WHERE id=?", (photo_id,)).fetchone():
        raise PositionError("Photo introuvable")
    conn.execute("UPDATE photo SET lat=?, lon=?, pos_method=?, time_offset=NULL WHERE id=?", (lat, lon, method, photo_id))


def offset(conn, ids: list[int], east_m: float, north_m: float) -> int:
    """Translate photos by a vector in meters."""
    dist = math.hypot(east_m, north_m)
    if dist == 0:
        return 0
    az = math.degrees(math.atan2(east_m, north_m))
    rows = [r for r in _current(conn, ids) if r["lat"] is not None and geo.valid_coord(r["lat"], r["lon"])]
    for r in rows:
        lon, lat, _ = geo.GEOD.fwd(r["lon"], r["lat"], az, dist)
        conn.execute("UPDATE photo SET lat=?, lon=?, pos_method='offset', time_offset=NULL WHERE id=?", (lat, lon, r["id"]))
    return len(rows)


def along(conn, ids: list[int], meters: float) -> tuple[int, int]:
    """Move photos forward (>0) or backward (<0) along their direction of travel (computed heading)."""
    moved = skipped = 0
    for r in _current(conn, ids):
        if r["lat"] is None or r["heading_auto"] is None:
            skipped += 1
            continue
        lon, lat, _ = geo.GEOD.fwd(r["lon"], r["lat"], r["heading_auto"], meters)
        conn.execute("UPDATE photo SET lat=?, lon=?, pos_method='along', time_offset=NULL WHERE id=?", (lat, lon, r["id"]))
        moved += 1
    return moved, skipped


def revert(conn, ids: list[int]) -> int:
    if not ids:
        return 0
    ph = ",".join("?" * len(ids))
    return conn.execute(f"UPDATE photo SET lat=NULL, lon=NULL, pos_method=NULL, time_offset=NULL WHERE id IN ({ph})", ids).rowcount


def ids_in_range(conn, start_idx: int, end_idx: int) -> list[int]:
    a, b = sorted((start_idx, end_idx))
    return [r[0] for r in conn.execute("SELECT id FROM photo WHERE idx BETWEEN ? AND ? ORDER BY idx", (a, b))]


def corrected_count(conn) -> int:
    return conn.execute("SELECT COUNT(*) FROM photo WHERE lat IS NOT NULL").fetchone()[0]



# ---- Photos without a position ----

# Photos that can never be placed (or used): not listed as "without position"
UNUSABLE = db.DUPLICATE | db.UNREADABLE | db.MISSING_FILE
# Manual corrections: never overwritten by the time synchronisation or by snapping
MANUAL_METHODS = ("manual", "offset", "along", "interp", "osm", "gpx")


def _positioned_sql() -> str:
    """SQL condition: the photo has a usable position (corrected, or original and valid)."""
    return f"(p.lat IS NOT NULL OR (p.lat_orig IS NOT NULL AND p.flags & {db.NO_GPS | db.INVALID_COORD} = 0))"


def missing_runs(conn) -> list[dict]:
    """Blocks of consecutive photos without a position, with the positioned photos just before / after them."""
    rows = conn.execute(
        f"""SELECT p.id, p.idx, p.ts, p.sequence_id, p.excluded, p.flags,
                   {_positioned_sql()} AS placed, COALESCE(p.lat, p.lat_orig) lat, COALESCE(p.lon, p.lon_orig) lon
            FROM photo p ORDER BY p.idx"""
    ).fetchall()
    usable = [r for r in rows if not r["excluded"] and not r["flags"] & UNUSABLE]
    runs, cur, prev = [], [], None

    def close(nxt):
        if not cur:
            return
        seq = prev["sequence_id"] if prev and nxt and prev["sequence_id"] == nxt["sequence_id"] else None
        side = lambda r: {"id": r["id"], "idx": r["idx"], "ts": r["ts"], "lat": r["lat"], "lon": r["lon"]} if r else None
        runs.append(
            {
                "ids": [r["id"] for r in cur],
                "start_idx": cur[0]["idx"],
                "end_idx": cur[-1]["idx"],
                "count": len(cur),
                "prev": side(prev),
                "next": side(nxt),
                "sequence_id": seq if seq is not None else next((r["sequence_id"] for r in cur if r["sequence_id"]), None),
            }
        )
        cur.clear()

    for r in usable:
        if r["placed"]:
            close(r)
            prev = r
        else:
            cur.append(r)
    close(None)
    return runs


def interpolate(conn, ids: list[int]) -> tuple[int, int]:
    """Place photos without a position between the positioned photos before and after them, in proportion to
    their capture time (or to their rank when a time is missing). Returns (placed, skipped)."""
    wanted = set(ids)
    placed = skipped = 0
    for run in missing_runs(conn):
        todo = [i for i in run["ids"] if i in wanted]
        if not todo:
            continue
        a, b = run["prev"], run["next"]
        if not a or not b:
            skipped += len(todo)  # at the start / end of the ride: nothing to interpolate between
            continue
        n = len(run["ids"])
        rows = {r["id"]: r for r in conn.execute(f"SELECT id, ts FROM photo WHERE id IN ({','.join('?' * n)})", run["ids"])}
        dist, az = geo.distance(a["lat"], a["lon"], b["lat"], b["lon"]), geo.azimuth(a["lat"], a["lon"], b["lat"], b["lon"])
        for k, pid in enumerate(run["ids"], 1):
            if pid not in wanted:
                continue
            ts = rows[pid]["ts"]
            if ts is not None and a["ts"] is not None and b["ts"] is not None and b["ts"] > a["ts"]:
                f = min(1.0, max(0.0, (ts - a["ts"]) / (b["ts"] - a["ts"])))
            else:
                f = k / (n + 1)
            lon, lat, _ = geo.GEOD.fwd(a["lon"], a["lat"], az, dist * f)
            conn.execute("UPDATE photo SET lat=?, lon=?, pos_method='interp', time_offset=NULL WHERE id=?", (lat, lon, pid))
            placed += 1
    return placed, skipped


def attach_to_sequences(conn, ids: list[int]) -> int:
    """A photo that just got a position joins the sequence of its neighbours, if the photos before and after it
    (usable, not excluded) belong to the same sequence. Returns the number of photos attached."""
    from . import sequences

    if not ids:
        return 0
    ph = ",".join("?" * len(ids))
    cand = conn.execute(
        f"""SELECT p.id, p.idx FROM photo p WHERE p.id IN ({ph}) AND p.sequence_id IS NULL AND p.excluded = 0
              AND {db.EFF_FLAGS_SQL} & ? = 0""",
        (*ids, sequences.EXCLUDED),
    ).fetchall()
    if not cand:
        return 0
    # Usable photos in ride order; the candidates themselves are skipped when looking for the neighbours
    order = conn.execute(
        f"""SELECT p.id, p.sequence_id FROM photo p WHERE p.excluded = 0 AND {db.EFF_FLAGS_SQL} & ? = 0 ORDER BY p.idx""",
        (sequences.EXCLUDED,),
    ).fetchall()
    pos = {r["id"]: k for k, r in enumerate(order)}
    cids = {r["id"] for r in cand}
    attached, touched = 0, set()
    for r in cand:
        k = pos[r["id"]]
        before = next((order[i]["sequence_id"] for i in range(k - 1, -1, -1) if order[i]["id"] not in cids), None)
        after = next((order[i]["sequence_id"] for i in range(k + 1, len(order)) if order[i]["id"] not in cids), None)
        if before is not None and before == after:
            conn.execute("UPDATE photo SET sequence_id=? WHERE id=?", (before, r["id"]))
            touched.add(before)
            attached += 1
    for sid in touched:
        sequences._renumber(conn, sid)
    return attached
