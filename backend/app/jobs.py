"""Minimal background job queue: one thread per job, state persisted in the project database.

Jobs left `running` when the application stopped are marked `interrupted` at startup; resumable
work (thumbnails) is restarted from what is still pending in the database.
"""

import threading
import time
import traceback
import uuid
from typing import Callable

from . import db


class Cancelled(Exception):
    pass


class UserError(Exception):
    """Error whose message is meant for the user (shown as is on the job)."""


class JobContext:
    def __init__(self, project_id: str, job_id: str):
        self.project_id = project_id
        self.id = job_id
        self.cancel_event = threading.Event()
        self._last_write = 0.0

    def check(self) -> None:
        if self.cancel_event.is_set():
            raise Cancelled()

    def progress(self, done: int, total: int | None = None, message: str | None = None, force=False) -> None:
        now = time.time()
        if not force and now - self._last_write < 0.3:
            return
        self._last_write = now
        with db.open_project(self.project_id) as conn:
            sets, args = ["done=?", "updated_at=?"], [done, now]
            if total is not None:
                sets.append("total=?")
                args.append(total)
            if message is not None:
                sets.append("message=?")
                args.append(message)
            conn.execute(f"UPDATE job SET {', '.join(sets)} WHERE id=?", (*args, self.id))


_running: dict[str, JobContext] = {}
_lock = threading.Lock()


def start(project_id: str, kind: str, fn: Callable[[JobContext], None], unique=True) -> str:
    """Run fn(ctx) in a background thread. With unique=True, reuse a running job of the same kind."""
    with _lock:
        if unique:
            for ctx in _running.values():
                if ctx.project_id == project_id and getattr(ctx, "kind", None) == kind:
                    return ctx.id
        job_id = uuid.uuid4().hex
        ctx = JobContext(project_id, job_id)
        ctx.kind = kind
        _running[job_id] = ctx
    now = time.time()
    with db.open_project(project_id) as conn:
        conn.execute(
            "INSERT INTO job(id, kind, state, created_at, updated_at) VALUES(?, ?, 'running', ?, ?)",
            (job_id, kind, now, now),
        )

    def runner():
        state, message = "done", None
        try:
            fn(ctx)
        except Cancelled:
            state, message = "cancelled", "Annulé"
        except db.ProjectNotFound:
            state = "cancelled"
        except UserError as e:
            state, message = "error", str(e)
        except Exception as e:  # keep the UI alive: the error is reported on the job
            traceback.print_exc()
            state, message = "error", f"{type(e).__name__}: {e}"
        finally:
            with _lock:
                _running.pop(job_id, None)
            try:
                with db.open_project(project_id) as conn:
                    conn.execute(
                        "UPDATE job SET state=?, message=COALESCE(?, message), updated_at=? WHERE id=?",
                        (state, message, time.time(), job_id),
                    )
            except db.ProjectNotFound:
                pass

    threading.Thread(target=runner, name=f"job-{kind}-{job_id[:6]}", daemon=True).start()
    return job_id


def cancel(job_id: str) -> bool:
    with _lock:
        ctx = _running.get(job_id)
    if ctx:
        ctx.cancel_event.set()
    return ctx is not None


def cancel_project(project_id: str) -> None:
    with _lock:
        ctxs = [c for c in _running.values() if c.project_id == project_id]
    for c in ctxs:
        c.cancel_event.set()


def wait_project(project_id: str, timeout=30.0) -> None:
    end = time.time() + timeout
    while time.time() < end:
        with _lock:
            if not any(c.project_id == project_id for c in _running.values()):
                return
        time.sleep(0.05)


def list_jobs(conn, limit=20) -> list[dict]:
    rows = conn.execute("SELECT * FROM job ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]


def mark_interrupted(conn) -> None:
    conn.execute("UPDATE job SET state='interrupted' WHERE state='running'")
