"""Manual position corrections. The original coordinates (lat_orig/lon_orig) are never modified:
the corrected position lives in photo.lat/lon (NULL = original), with photo.pos_method.

All functions must run inside `undo.undoable(...)`; the caller then recomputes headings.
"""

import math

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

