"""Sequences: ordered groups of photos. A photo belongs to at most one sequence.

All mutating functions must be called inside `undo.undoable(...)` (they do not open transactions).
"""

import re
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


DEFAULT_NAME = re.compile(r"^Séquence \d+$")


def renumber_default_names(conn) -> None:
    """Sequences still named "Séquence N" are renumbered in chronological order (custom names are kept)."""
    rows = conn.execute(
        "SELECT s.id, s.name FROM sequence s JOIN photo p ON p.sequence_id = s.id GROUP BY s.id ORDER BY MIN(p.idx)"
    ).fetchall()
    for i, r in enumerate(rows, 1):
        if DEFAULT_NAME.match(r["name"]) and r["name"] != f"Séquence {i}":
            conn.execute("UPDATE sequence SET name=? WHERE id=?", (f"Séquence {i}", r["id"]))


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
        f"""SELECT p.id, {db.EFF_FLAGS_SQL} flags, p.sequence_id, p.excluded FROM photo p
            WHERE p.idx BETWEEN ? AND ? ORDER BY p.idx""",
        (start_idx, end_idx),
    ).fetchall()
    ids, excluded, conflicts = [], 0, set()
    for r in rows:
        if r["flags"] & EXCLUDED or r["excluded"]:
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
    renumber_default_names(conn)
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
    renumber_default_names(conn)


def split(conn, sid: int, photo_id: int) -> int:
    """Photos from photo_id (included) to the end go to a new sequence. Returns the new id."""
    seq = _get(conn, sid)
    row = conn.execute("SELECT idx, sequence_id FROM photo WHERE id=?", (photo_id,)).fetchone()
    if not row or row["sequence_id"] != sid:
        raise SequenceError("La photo n'appartient pas à cette séquence")
    first = conn.execute("SELECT MIN(idx) FROM photo WHERE sequence_id=?", (sid,)).fetchone()[0]
    if row["idx"] == first:
        raise SequenceError("Impossible de couper avant la première photo")
    # default names are renumbered by position; a custom name gets " (suite)"
    name = _next_name(conn) if DEFAULT_NAME.match(seq["name"]) else f"{seq['name']} (suite)"
    cur = conn.execute(
        "INSERT INTO sequence(name, heading_offset, created_at) VALUES(?, ?, ?)",
        (name, seq["heading_offset"], time.time()),
    )
    new = cur.lastrowid
    conn.execute("UPDATE photo SET sequence_id=? WHERE sequence_id=? AND idx>=?", (new, sid, row["idx"]))
    _renumber(conn, sid)
    _renumber(conn, new)
    renumber_default_names(conn)
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
    renumber_default_names(conn)
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
    renumber_default_names(conn)


def propose_cuts(conn, gap_s: float | None = None, max_dist_m: float = 100.0, min_photos: int = 5) -> list[dict]:
    """Proposed segments among unclassified usable photos: cut on time gaps and abnormal distances.

    Nothing is created: the user validates (possibly after editing) with create_many.
    """
    s = db.get_settings(conn)
    gap_s = gap_s if gap_s is not None else s["gap_seconds"]
    rows = conn.execute(
        f"""SELECT p.id, p.idx, p.ts, COALESCE(p.lat, p.lat_orig) lat, COALESCE(p.lon, p.lon_orig) lon,
                   {db.EFF_FLAGS_SQL} flags, p.sequence_id
            FROM photo p WHERE {db.EFF_FLAGS_SQL} & ? = 0 AND p.excluded = 0 ORDER BY p.idx""",
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


def cut_at(conn, photo_id: int) -> str:
    """One key to cut the ride while browsing it.

    - photo in a sequence: the sequence is split before this photo;
    - unclassified photo: a sequence is created over the whole block of unclassified photos around it
      (bounded by existing sequences), then split before this photo — so pressing the key at every cut point,
      from the start of a ride, produces all the sequences.
    Returns a short description of what was done."""
    row = conn.execute("SELECT idx, sequence_id FROM photo WHERE id=?", (photo_id,)).fetchone()
    if not row:
        raise SequenceError("Photo introuvable")
    if row["sequence_id"] is not None:
        split(conn, row["sequence_id"], photo_id)
        return "Séquence coupée"
    idx = row["idx"]
    before = conn.execute("SELECT MAX(idx) FROM photo WHERE sequence_id IS NOT NULL AND idx < ?", (idx,)).fetchone()[0]
    after = conn.execute("SELECT MIN(idx) FROM photo WHERE sequence_id IS NOT NULL AND idx > ?", (idx,)).fetchone()[0]
    lo = (before + 1) if before is not None else 0
    hi = (after - 1) if after is not None else conn.execute("SELECT MAX(idx) FROM photo").fetchone()[0]
    ids, _, _ = _eligible(conn, lo, hi)
    if not ids:
        raise SequenceError("Aucune photo utilisable autour de cette photo")
    first = conn.execute(f"SELECT MIN(idx) FROM photo WHERE id IN ({','.join('?' * len(ids))})", ids).fetchone()[0]
    res = create(conn, lo, hi)
    # cut before the first usable photo at or after the current one
    cut = conn.execute("SELECT id, idx FROM photo WHERE sequence_id=? AND idx>=? ORDER BY idx LIMIT 1", (res["id"], idx)).fetchone()
    if cut is None or cut["idx"] == first:
        return "Séquence créée"
    split(conn, res["id"], cut["id"])
    return "Séquence créée et coupée"


def create_from_unclassified(conn) -> list[dict]:
    """One sequence per block of unclassified photos (blocks are bounded by existing sequences).
    On a new project: the whole ride in one sequence, to be cut afterwards (key C)."""
    rows = conn.execute("SELECT idx, sequence_id FROM photo ORDER BY idx").fetchall()
    blocks, start = [], None
    for r in rows:
        if r["sequence_id"] is None:
            start = r["idx"] if start is None else start
        elif start is not None:
            blocks.append((start, r["idx"] - 1))
            start = None
    if start is not None:
        blocks.append((start, rows[-1]["idx"]))
    out = []
    for a, b in blocks:
        if _eligible(conn, a, b)[0]:
            out.append(create(conn, a, b))
    if not out:
        raise SequenceError("Aucune photo non classée utilisable")
    return out


def set_excluded(conn, photo_ids: list[int], excluded: bool) -> int:
    """Exclude photos (out of their sequence, never exported) or put them back.

    A photo put back between two photos of the same sequence returns into that sequence."""
    if not photo_ids:
        return 0
    if excluded:
        remove_photos(conn, photo_ids)
        ph = ",".join("?" * len(photo_ids))
        return conn.execute(f"UPDATE photo SET excluded=1 WHERE id IN ({ph}) AND excluded=0", photo_ids).rowcount
    n = 0
    touched = set()
    for pid in photo_ids:
        r = conn.execute("SELECT idx, excluded FROM photo WHERE id=?", (pid,)).fetchone()
        if not r or not r["excluded"]:
            continue
        conn.execute("UPDATE photo SET excluded=0 WHERE id=?", (pid,))
        n += 1
        prev = conn.execute("SELECT sequence_id FROM photo WHERE idx<? AND sequence_id IS NOT NULL ORDER BY idx DESC LIMIT 1", (r["idx"],)).fetchone()
        nxt = conn.execute("SELECT sequence_id FROM photo WHERE idx>? AND sequence_id IS NOT NULL ORDER BY idx LIMIT 1", (r["idx"],)).fetchone()
        if prev and nxt and prev[0] == nxt[0] and _eligible(conn, r["idx"], r["idx"])[0]:
            conn.execute("UPDATE photo SET sequence_id=? WHERE id=?", (prev[0], pid))
            touched.add(prev[0])
    for sid in touched:
        _renumber(conn, sid)
    return n


def create_many(conn, segments: list[tuple[int, int]]) -> list[dict]:
    return [create(conn, a, b) for a, b in segments]


def list_with_stats(conn) -> list[dict]:
    seqs = conn.execute("SELECT * FROM sequence").fetchall()
    out = []
    for s in seqs:
        pts = conn.execute(
            f"""SELECT p.idx, p.ts, COALESCE(p.lat, p.lat_orig) lat, COALESCE(p.lon, p.lon_orig) lon,
                      {db.EFF_FLAGS_SQL} flags, p.lat IS NOT NULL corrected
               FROM photo p WHERE p.sequence_id=? ORDER BY p.idx""",
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
                "corrected": sum(1 for p in pts if p["corrected"]),
                "headings": headings.stats(conn, s["id"]),
            }
        )
    return sorted(out, key=lambda x: x["start_idx"])
