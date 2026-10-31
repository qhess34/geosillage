"""Sequences: ordered groups of photos. A photo belongs to at most one sequence.

All mutating functions must be called inside `undo.undoable(...)` (they do not open transactions).
"""

import time

from .. import db
from . import geo, headings

# Photos that cannot be put in a sequence (they stay in "unclassified")
EXCLUDED = db.DUPLICATE | db.NO_DATE | db.NO_GPS | db.INVALID_COORD | db.UNREADABLE | db.MISSING_FILE


class SequenceError(Exception):
    pass


def _renumber(conn, sid: int) -> None:
    ids = [r[0] for r in conn.execute("SELECT id FROM photo WHERE sequence_id=? ORDER BY idx", (sid,))]
    conn.executemany("UPDATE photo SET rank=? WHERE id=?", [(i + 1, pid) for i, pid in enumerate(ids)])


def _next_name(conn) -> str:
    n = conn.execute("SELECT COUNT(*) FROM sequence").fetchone()[0] + 1
    names = {r[0] for r in conn.execute("SELECT name FROM sequence")}
    while f"Séquence {n}" in names:
        n += 1
    return f"Séquence {n}"


def _eligible(conn, start_idx: int, end_idx: int, allow_sid=None) -> tuple[list[int], int, list[int]]:
    """(eligible photo ids, excluded count, conflicting sequence ids) in the idx range."""
    if start_idx > end_idx:
        start_idx, end_idx = end_idx, start_idx
    rows = conn.execute(
        "SELECT id, flags, sequence_id FROM photo WHERE idx BETWEEN ? AND ? ORDER BY idx", (start_idx, end_idx)
    ).fetchall()
    ids, excluded, conflicts = [], 0, set()
    for r in rows:
        if r["flags"] & EXCLUDED:
            excluded += 1
        elif r["sequence_id"] is not None and r["sequence_id"] != allow_sid:
            conflicts.add(r["sequence_id"])
        else:
            ids.append(r["id"])
    return ids, excluded, sorted(conflicts)


def create(conn, start_idx: int, end_idx: int, name: str | None = None) -> dict:
    ids, excluded, conflicts = _eligible(conn, start_idx, end_idx)
    if conflicts:
        names = [r[0] for r in conn.execute(f"SELECT name FROM sequence WHERE id IN ({','.join('?' * len(conflicts))})", conflicts)]
        raise SequenceError(f"La plage contient des photos déjà classées ({', '.join(names)})")
    if not ids:
        raise SequenceError("Aucune photo utilisable dans cette plage")
    cur = conn.execute(
        "INSERT INTO sequence(name, created_at) VALUES(?, ?)", ((name or "").strip() or _next_name(conn), time.time())
    )
    sid = cur.lastrowid
    conn.executemany("UPDATE photo SET sequence_id=? WHERE id=?", [(sid, i) for i in ids])
    _renumber(conn, sid)
    return {"id": sid, "count": len(ids), "excluded": excluded}


def set_bounds(conn, sid: int, start_idx: int, end_idx: int) -> dict:
    """Make the sequence contain exactly the eligible photos of the range (extend or shrink)."""
    _get(conn, sid)
    ids, excluded, conflicts = _eligible(conn, start_idx, end_idx, allow_sid=sid)
    if conflicts:
        raise SequenceError("La nouvelle plage chevauche une autre séquence")
    if not ids:
        raise SequenceError("Aucune photo utilisable dans cette plage")
    conn.execute("UPDATE photo SET sequence_id=NULL, rank=NULL WHERE sequence_id=?", (sid,))
    conn.executemany("UPDATE photo SET sequence_id=? WHERE id=?", [(sid, i) for i in ids])
    _renumber(conn, sid)
    return {"id": sid, "count": len(ids), "excluded": excluded}


def _get(conn, sid: int):
    row = conn.execute("SELECT * FROM sequence WHERE id=?", (sid,)).fetchone()
    if not row:
        raise SequenceError("Séquence introuvable")
    return row


def update(conn, sid: int, name: str | None = None, heading_offset: float | None = None) -> None:
    _get(conn, sid)
    if name is not None:
        if not name.strip():
            raise SequenceError("Nom vide")
        conn.execute("UPDATE sequence SET name=? WHERE id=?", (name.strip(), sid))
    if heading_offset is not None:
        conn.execute("UPDATE sequence SET heading_offset=? WHERE id=?", (((heading_offset + 180) % 360) - 180, sid))


def delete(conn, sid: int) -> None:
    _get(conn, sid)
    conn.execute("UPDATE photo SET sequence_id=NULL, rank=NULL WHERE sequence_id=?", (sid,))
    conn.execute("DELETE FROM sequence WHERE id=?", (sid,))


def split(conn, sid: int, photo_id: int) -> int:
    """Photos from photo_id (included) to the end go to a new sequence. Returns the new id."""
    seq = _get(conn, sid)
    row = conn.execute("SELECT idx, sequence_id FROM photo WHERE id=?", (photo_id,)).fetchone()
    if not row or row["sequence_id"] != sid:
        raise SequenceError("La photo n'appartient pas à cette séquence")
    first = conn.execute("SELECT MIN(idx) FROM photo WHERE sequence_id=?", (sid,)).fetchone()[0]
    if row["idx"] == first:
        raise SequenceError("Impossible de couper avant la première photo")
    cur = conn.execute(
        "INSERT INTO sequence(name, heading_offset, created_at) VALUES(?, ?, ?)",
        (f"{seq['name']} (suite)", seq["heading_offset"], time.time()),
    )
    new = cur.lastrowid
    conn.execute("UPDATE photo SET sequence_id=? WHERE sequence_id=? AND idx>=?", (new, sid, row["idx"]))
    _renumber(conn, sid)
    _renumber(conn, new)
    return new


def merge(conn, ids: list[int]) -> int:
    """Merge sequences into the earliest one (photos between them stay where they are)."""
    if len(set(ids)) < 2:
        raise SequenceError("Sélectionnez au moins deux séquences")
    for i in ids:
        _get(conn, i)
    ph = ",".join("?" * len(ids))
    lo, hi = conn.execute(f"SELECT MIN(idx), MAX(idx) FROM photo WHERE sequence_id IN ({ph})", ids).fetchone()
    if conn.execute(
        f"SELECT 1 FROM photo WHERE idx BETWEEN ? AND ? AND sequence_id IS NOT NULL AND sequence_id NOT IN ({ph}) LIMIT 1",
        (lo, hi, *ids),
    ).fetchone():
        raise SequenceError("Seules des séquences voisines peuvent être fusionnées")
    target = conn.execute(
        f"SELECT sequence_id FROM photo WHERE sequence_id IN ({ph}) ORDER BY idx LIMIT 1", ids
    ).fetchone()[0]
    others = [i for i in set(ids) if i != target]
    oh = ",".join("?" * len(others))
    conn.execute(f"UPDATE photo SET sequence_id=? WHERE sequence_id IN ({oh})", (target, *others))
    conn.execute(f"DELETE FROM sequence WHERE id IN ({oh})", others)
    _renumber(conn, target)
    return target


def remove_photos(conn, photo_ids: list[int]) -> None:
    sids = {r[0] for r in conn.execute(
        f"SELECT DISTINCT sequence_id FROM photo WHERE id IN ({','.join('?' * len(photo_ids))}) AND sequence_id IS NOT NULL",
        photo_ids,
    )}
    conn.executemany("UPDATE photo SET sequence_id=NULL, rank=NULL WHERE id=?", [(i,) for i in photo_ids])
    for sid in sids:
        if conn.execute("SELECT 1 FROM photo WHERE sequence_id=? LIMIT 1", (sid,)).fetchone():
            _renumber(conn, sid)
        else:
            conn.execute("DELETE FROM sequence WHERE id=?", (sid,))


def propose_cuts(conn, gap_s: float | None = None, max_dist_m: float = 100.0, min_photos: int = 5) -> list[dict]:
    """Proposed segments among unclassified usable photos: cut on time gaps and abnormal distances.

    Nothing is created: the user validates (possibly after editing) with create_many.
    """
    s = db.get_settings(conn)
    gap_s = gap_s if gap_s is not None else s["gap_seconds"]
    rows = conn.execute(
        f"""SELECT id, idx, ts, COALESCE(lat, lat_orig) lat, COALESCE(lon, lon_orig) lon, flags, sequence_id
            FROM photo WHERE flags & ? = 0 ORDER BY idx""",
        (EXCLUDED,),
    ).fetchall()
    segments: list[dict] = []
    cur: list = []
    reason = "début"

    def close(next_reason):
        nonlocal cur, reason
        if cur:
            segments.append({"start_idx": cur[0]["idx"], "end_idx": cur[-1]["idx"], "count": len(cur), "reason": reason})
        cur, reason = [], next_reason

    for r in rows:
        if r["sequence_id"] is not None:
            close("séquence existante")
            continue
        if cur:
            dt = r["ts"] - cur[-1]["ts"]
            # Distance from the last reliable position (isolated GPS jumps are not a reason to cut)
            ref = next((p for p in reversed(cur) if not p["flags"] & db.GPS_JUMP), None)
            d = geo.distance(ref["lat"], ref["lon"], r["lat"], r["lon"]) if ref else 0.0
            if dt > gap_s:
                close(f"interruption de {round(dt)} s")
            elif d > max_dist_m and not r["flags"] & db.GPS_JUMP:
                close(f"saut de {round(d)} m")
        cur.append(r)
    close("")
    return [seg for seg in segments if seg["count"] >= min_photos]


def create_many(conn, segments: list[tuple[int, int]]) -> list[dict]:
    return [create(conn, a, b) for a, b in segments]


def list_with_stats(conn) -> list[dict]:
    seqs = conn.execute("SELECT * FROM sequence").fetchall()
    out = []
    for s in seqs:
        pts = conn.execute(
            """SELECT idx, ts, COALESCE(lat, lat_orig) lat, COALESCE(lon, lon_orig) lon, flags
               FROM photo WHERE sequence_id=? ORDER BY idx""",
            (s["id"],),
        ).fetchall()
        if not pts:
            continue
        track = [(p["lat"], p["lon"]) for p in pts if not p["flags"] & db.GPS_JUMP]
        anomalies = sum(1 for p in pts if p["flags"] & (db.GPS_JUMP | db.SAME_TIME))
        jumps = sum(1 for p in pts if p["flags"] & db.GPS_JUMP)
        out.append(
            {
                "id": s["id"],
                "name": s["name"],
                "heading_offset": s["heading_offset"],
                "count": len(pts),
                "start_idx": pts[0]["idx"],
                "end_idx": pts[-1]["idx"],
                "start": pts[0]["ts"],
                "end": pts[-1]["ts"],
                "duration_s": pts[-1]["ts"] - pts[0]["ts"],
                "distance_m": round(geo.path_length(track), 1),
                "anomalies": anomalies,
                "gps_jumps": jumps,
                "headings": headings.stats(conn, s["id"]),
            }
        )
    return sorted(out, key=lambda x: x["start_idx"])
