"""Routes: connection to a Panoramax instance and publication of sequences."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import db, jobs, panoramax

router = APIRouter(prefix="/api")


def _err(fn):
    try:
        return fn()
    except panoramax.PanoramaxError as e:
        raise HTTPException(409, str(e))


class InstanceIn(BaseModel):
    url: str = Field(min_length=8, max_length=300)


@router.get("/panoramax")
def pnx_status():
    """Instance, connection state, account name (never the token)."""
    return panoramax.status()


@router.put("/panoramax/instance")
def pnx_instance(body: InstanceIn):
    return _err(lambda: panoramax.set_instance(body.url))


@router.post("/panoramax/login")
def pnx_login():
    """New token: the user must open `claim_url` and log in on the instance."""
    return _err(panoramax.login)


@router.post("/panoramax/check")
def pnx_check():
    return _err(panoramax.check)


@router.post("/panoramax/logout")
def pnx_logout():
    return panoramax.logout()


class PublishIn(BaseModel):
    sequence_ids: list[int] = Field(min_length=1)
    visibility: str = Field(default="anyone", pattern="^(anyone|owner-only)$")
    bike: bool = True  # semantics transport=bike


@router.post("/projects/{pid}/publish", status_code=202)
def publish(pid: str, body: PublishIn):
    with db.open_project(pid) as conn:
        known = {r[0] for r in conn.execute("SELECT id FROM sequence")}
        running = any(j["state"] == "running" and j["kind"] in ("publish", "export", "import") for j in jobs.list_jobs(conn, 20))
    if set(body.sequence_ids) - known:
        raise HTTPException(404, "Séquence introuvable")
    if running:
        raise HTTPException(409, "Une autre tâche (export, import, publication) est en cours")
    _err(panoramax._account)  # connected?
    return {"job_id": jobs.start(pid, "publish", lambda ctx: panoramax.publish(ctx, pid, body.sequence_ids, body.visibility, body.bike), unique=False)}


@router.get("/projects/{pid}/publications")
def publications(pid: str):
    with db.open_project(pid) as conn:
        rows = conn.execute("SELECT p.*, s.name FROM publication p LEFT JOIN sequence s ON s.id = p.sequence_id ORDER BY p.id DESC LIMIT 50")
        return [dict(r) for r in rows]
