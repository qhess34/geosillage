"""Generic undo/redo for user edits.

An operation runs inside `undoable(conn, label)`. The editable photo columns and the sequence table are
captured before and after; only the photo rows that changed are journaled, so a 10 000-photo project stays
cheap. Undo writes the "before" values back, redo the "after" values. Derived data (computed headings) is
recomputed by the caller after undo/redo.
"""

import json
import time
from contextlib import contextmanager

from . import db, i18n

# new columns go at the end: operations journaled before they existed only restore the columns they knew
PHOTO_COLS = ["sequence_id", "rank", "heading_manual", "lat", "lon", "pos_method", "time_offset", "excluded", "yaw_offset", "heading_offset", "heading_kept"]
SEQ_COLS = ["id", "name", "heading_offset", "created_at", "modified_at"]
MAX_OPS = 200


class NothingToDo(Exception):
    pass


def _photos(conn) -> dict[int, tuple]:
    rows = conn.execute(f"SELECT id, {', '.join(PHOTO_COLS)} FROM photo").fetchall()
    return {r[0]: tuple(r[1:]) for r in rows}


def _sequences(conn) -> list[list]:
    return [list(r) for r in conn.execute(f"SELECT {', '.join(SEQ_COLS)} FROM sequence ORDER BY id")]


@contextmanager
def undoable(conn, label: str):
    """Run the block in a transaction and journal its changes. Yields nothing."""
    with db.transaction(conn):
        before_p, before_s = _photos(conn), _sequences(conn)
        yield
        after_p, after_s = _photos(conn), _sequences(conn)
        changed = [i for i, v in after_p.items() if before_p.get(i) != v]
        if not changed and before_s == after_s:
            return
        data = {
            "photos": [[i, before_p[i], after_p[i]] for i in changed],
            "seq_before": before_s,
            "seq_after": after_s,
        }
        touch(conn, affected_sequences(data))
        conn.execute("DELETE FROM op_log WHERE undone = 1")  # a new edit clears the redo stack
        conn.execute("INSERT INTO op_log(ts, label, data) VALUES(?, ?, ?)", (time.time(), label, json.dumps(data)))
        conn.execute(
            "DELETE FROM op_log WHERE id NOT IN (SELECT id FROM op_log ORDER BY id DESC LIMIT ?)", (MAX_OPS,)
        )


# columns that do not change what is exported (a sequence is not marked « à réexporter » for them)
NOT_EXPORTED = {PHOTO_COLS.index("heading_kept")}


def affected_sequences(data: dict) -> set[int]:
    """Sequences whose content an operation changed (photos leaving / joining / edited, or the sequence row)."""
    k = PHOTO_COLS.index("sequence_id")
    exported = lambda row: [v for i, v in enumerate(row) if i not in NOT_EXPORTED]  # noqa: E731
    ids = {v for _, b, a in data["photos"] if exported(b) != exported(a) for v in (b[k], a[k]) if v is not None}
    before = {s[0]: s[:4] for s in data["seq_before"]}
    ids |= {s[0] for s in data["seq_after"] if before.get(s[0]) != s[:4]}
    return ids


def touch(conn, sequence_ids) -> None:
    """Mark sequences as modified now (they need to be exported again)."""
    ids = list(sequence_ids)
    if ids:
        conn.execute(f"UPDATE sequence SET modified_at=? WHERE id IN ({','.join('?' * len(ids))})", (time.time(), *ids))


def touch_all(conn) -> None:
    conn.execute("UPDATE sequence SET modified_at=?", (time.time(),))


def _apply(conn, data: dict, side: str) -> None:
    k = 1 if side == "before" else 2
    for row in data["photos"]:
        cols = PHOTO_COLS[: len(row[k])]
        conn.execute(f"UPDATE photo SET {', '.join(f'{c}=?' for c in cols)} WHERE id=?", (*row[k], row[0]))
    seqs = data["seq_before" if side == "before" else "seq_after"]
    conn.execute("DELETE FROM sequence")
    conn.executemany(f"INSERT INTO sequence({', '.join(SEQ_COLS)}) VALUES({', '.join('?' * len(SEQ_COLS))})", [(*s, None)[: len(SEQ_COLS)] for s in seqs])
    touch(conn, affected_sequences(data))  # undone / redone content differs from what may have been exported


def undo(conn) -> str:
    with db.transaction(conn):
        row = conn.execute("SELECT id, label, data FROM op_log WHERE undone = 0 ORDER BY id DESC LIMIT 1").fetchone()
        if not row:
            raise NothingToDo()
        _apply(conn, json.loads(row["data"]), "before")
        conn.execute("UPDATE op_log SET undone = 1 WHERE id=?", (row["id"],))
    return i18n.tr(row["label"])


def redo(conn) -> str:
    with db.transaction(conn):
        row = conn.execute("SELECT id, label, data FROM op_log WHERE undone = 1 ORDER BY id ASC LIMIT 1").fetchone()
        if not row:
            raise NothingToDo()
        _apply(conn, json.loads(row["data"]), "after")
        conn.execute("UPDATE op_log SET undone = 0 WHERE id=?", (row["id"],))
    return i18n.tr(row["label"])


def state(conn) -> dict:
    u = conn.execute("SELECT label FROM op_log WHERE undone = 0 ORDER BY id DESC LIMIT 1").fetchone()
    r = conn.execute("SELECT label FROM op_log WHERE undone = 1 ORDER BY id ASC LIMIT 1").fetchone()
    return {"undo": i18n.tr(u[0]) if u else None, "redo": i18n.tr(r[0]) if r else None}


def history(conn, limit=50) -> list[dict]:
    rows = conn.execute("SELECT id, ts, label, undone FROM op_log ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [{**dict(r), "label": i18n.tr(r["label"])} for r in rows]
