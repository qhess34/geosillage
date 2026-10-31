"""Generic undo/redo for user edits.

An operation runs inside `undoable(conn, label)`. The editable photo columns and the sequence table are
captured before and after; only the photo rows that changed are journaled, so a 10 000-photo project stays
cheap. Undo writes the "before" values back, redo the "after" values. Derived data (computed headings) is
recomputed by the caller after undo/redo.
"""

import json
import time
from contextlib import contextmanager

from . import db

PHOTO_COLS = ["sequence_id", "rank", "heading_manual", "lat", "lon", "pos_method"]
SEQ_COLS = ["id", "name", "heading_offset", "created_at"]
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
        conn.execute("DELETE FROM op_log WHERE undone = 1")  # a new edit clears the redo stack
        conn.execute("INSERT INTO op_log(ts, label, data) VALUES(?, ?, ?)", (time.time(), label, json.dumps(data)))
        conn.execute(
            "DELETE FROM op_log WHERE id NOT IN (SELECT id FROM op_log ORDER BY id DESC LIMIT ?)", (MAX_OPS,)
        )


def _apply(conn, data: dict, side: str) -> None:
    k = 1 if side == "before" else 2
    sets = ", ".join(f"{c}=?" for c in PHOTO_COLS)
    conn.executemany(f"UPDATE photo SET {sets} WHERE id=?", [(*row[k], row[0]) for row in data["photos"]])
    seqs = data["seq_before" if side == "before" else "seq_after"]
    conn.execute("DELETE FROM sequence")
    conn.executemany(f"INSERT INTO sequence({', '.join(SEQ_COLS)}) VALUES(?, ?, ?, ?)", seqs)


def undo(conn) -> str:
    with db.transaction(conn):
        row = conn.execute("SELECT id, label, data FROM op_log WHERE undone = 0 ORDER BY id DESC LIMIT 1").fetchone()
        if not row:
            raise NothingToDo()
        _apply(conn, json.loads(row["data"]), "before")
        conn.execute("UPDATE op_log SET undone = 1 WHERE id=?", (row["id"],))
    return row["label"]


def redo(conn) -> str:
    with db.transaction(conn):
        row = conn.execute("SELECT id, label, data FROM op_log WHERE undone = 1 ORDER BY id ASC LIMIT 1").fetchone()
        if not row:
            raise NothingToDo()
        _apply(conn, json.loads(row["data"]), "after")
        conn.execute("UPDATE op_log SET undone = 0 WHERE id=?", (row["id"],))
    return row["label"]


def state(conn) -> dict:
    u = conn.execute("SELECT label FROM op_log WHERE undone = 0 ORDER BY id DESC LIMIT 1").fetchone()
    r = conn.execute("SELECT label FROM op_log WHERE undone = 1 ORDER BY id ASC LIMIT 1").fetchone()
    return {"undo": u[0] if u else None, "redo": r[0] if r else None}


def history(conn, limit=50) -> list[dict]:
    rows = conn.execute("SELECT id, ts, label, undone FROM op_log ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]
