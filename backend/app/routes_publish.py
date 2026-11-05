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


# ---- Already published sequences ----


class LinkIn(BaseModel):
    collection: str = Field(min_length=10, max_length=500)  # address or identifier of the published sequence


@router.post("/projects/{pid}/sequences/{sid}/panoramax/link")
def pnx_link(pid: str, sid: int, body: LinkIn):
    """Link a sequence published outside the application (pictures matched by file name, then capture time)."""
    return _err(lambda: panoramax.link(pid, sid, body.collection))


@router.get("/projects/{pid}/sequences/{sid}/panoramax/compare")
def pnx_compare(pid: str, sid: int):
    """What would be sent: counts of positions / headings / orientations to correct, pictures to delete."""
    d = _err(lambda: panoramax.compare(pid, sid))
    return {k: v for k, v in d.items() if not k.startswith("_")}


class PushIn(BaseModel):
    delete_excluded: bool = False


@router.post("/projects/{pid}/sequences/{sid}/panoramax/push", status_code=202)
def pnx_push(pid: str, sid: int, body: PushIn):
    _err(panoramax._account)
    return {"job_id": jobs.start(pid, "publish_update", lambda ctx: panoramax.push(ctx, pid, sid, body.delete_excluded), unique=False)}


@router.post("/projects/{pid}/sequences/{sid}/panoramax/revert", status_code=202)
def pnx_revert(pid: str, sid: int):
    _err(panoramax._account)
    return {"job_id": jobs.start(pid, "publish_update", lambda ctx: panoramax.revert(ctx, pid, sid), unique=False)}
