"""FastAPI application: REST API + built frontend, served on 127.0.0.1 only."""

import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError

from . import config, db, exporter, importer, jobs, panoramax, routes_edit, routes_publish, undo
from .core import analysis, headings
from .exif import reader


@asynccontextmanager
async def lifespan(app):
    config.ensure_dirs()
    # Restore state after a restart: interrupted jobs, pending thumbnails
    for p in db.list_projects():
        with db.open_project(p["id"]) as conn:
            jobs.mark_interrupted(conn)
            headings.recompute(conn)  # computed headings follow the current algorithm / defaults
        importer.start_thumbnails(p["id"])
    yield


app = FastAPI(title="GeoSillage", lifespan=lifespan)
app.include_router(routes_edit.router)
app.include_router(routes_publish.router)


@app.exception_handler(db.ProjectNotFound)
async def not_found(request: Request, exc):
    return JSONResponse({"detail": "Projet introuvable"}, status_code=404)


# ---- Projects ----


class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class SettingsIn(BaseModel):
    gap_seconds: float | None = Field(default=None, gt=0)
    jump_speed_ms: float | None = Field(default=None, gt=0)
    jump_min_m: float | None = Field(default=None, ge=0)
    heading_min_m: float | None = Field(default=None, gt=0, le=100)
    heading_window_s: float | None = Field(default=None, gt=0, le=120)
    stop_m: float | None = Field(default=None, gt=0, le=50)
    stop_min: int | None = Field(default=None, ge=2, le=100)
    spacing_m: float | None = Field(default=None, gt=0, le=1000)
    dop_max: float | None = Field(default=None, gt=0, le=50)
    heading_diff: float | None = Field(default=None, ge=10, le=180)


class ImportIn(BaseModel):
    paths: list[str] = Field(min_length=1)


@app.get("/api/projects")
def projects_list():
    return db.list_projects()


@app.post("/api/projects", status_code=201)
def projects_create(body: ProjectIn):
    pid = db.create_project(body.name.strip())
    return {"id": pid}


@app.get("/api/projects/{pid}")
def project_get(pid: str):
    with db.open_project(pid) as conn:
        return {
            "id": pid,
            "name": db.get_meta(conn, "name"),
            "kind": db.get_meta(conn, "kind", "ride"),
            "pnx_instance": db.get_meta(conn, "pnx_instance"),
            "created_at": db.get_meta(conn, "created_at"),
            "settings": db.get_settings(conn),
            "source_dirs": [r[0] for r in conn.execute("SELECT path FROM source_dir ORDER BY added_at")],
            "summary": analysis.summary(conn),
            "headings": headings.stats(conn),
            "sources": exporter.modified_sources(conn),
            "sync_offset_s": db.get_meta(conn, "last_time_offset"),  # last GPS delay applied (step bar)
            "corrected_positions": conn.execute("SELECT COUNT(*) FROM photo WHERE lat IS NOT NULL").fetchone()[0],
            "jobs": jobs.list_jobs(conn, 10),
        }


@app.patch("/api/projects/{pid}")
def project_update(pid: str, body: dict):
    with db.open_project(pid) as conn:
        if "name" in body:
            name = str(body["name"]).strip()
            if not name:
                raise HTTPException(400, "Nom vide")
            db.set_meta(conn, "name", name)
        if "settings" in body:
            try:
                s = SettingsIn(**body["settings"]).model_dump(exclude_none=True)
            except ValidationError as e:  # a value out of range: refused, not a server error
                raise HTTPException(422, "Réglage invalide : " + "; ".join(f"{'.'.join(map(str, x['loc']))} : {x['msg']}" for x in e.errors()))
            db.set_meta(conn, "settings", {**(db.get_meta(conn, "settings", {}) or {}), **s})
            analysis.run(conn)
            headings.recompute(conn)
            undo.touch_all(conn)  # headings may have changed everywhere
    return project_get(pid)


@app.delete("/api/projects/{pid}", status_code=204)
def project_delete(pid: str):
    db.project_dir(pid)  # validates the id
    jobs.cancel_project(pid)
    jobs.wait_project(pid)
    db.delete_project(pid)


@app.post("/api/projects/{pid}/import", status_code=202)
def project_import(pid: str, body: ImportIn):
    with db.open_project(pid) as conn:
        routes_edit.ride_only(conn)
    for p in body.paths:
        if not os.path.exists(os.path.expanduser(p)):
            raise HTTPException(400, f"Chemin introuvable : {p}")
    with db.open_project(pid):
        pass
    return {"job_id": jobs.start(pid, "import", lambda ctx: importer.import_paths(ctx, body.paths))}


@app.post("/api/projects/{pid}/check-files", status_code=202)
def project_check_files(pid: str):
    with db.open_project(pid) as conn:
        routes_edit.ride_only(conn)
    with db.open_project(pid):
        pass
    return {"job_id": jobs.start(pid, "check_files", importer.check_files)}


@app.post("/api/projects/{pid}/thumbnails", status_code=202)
def project_thumbnails(pid: str, retry_failed: bool = False):
    with db.open_project(pid) as conn:
        if retry_failed:
            conn.execute("UPDATE photo SET thumb = 0 WHERE thumb = -1")
    return {"job_id": importer.start_thumbnails(pid)}


@app.get("/api/projects/{pid}/jobs")
def project_jobs(pid: str):
    with db.open_project(pid) as conn:
        return jobs.list_jobs(conn)


@app.post("/api/projects/{pid}/jobs/{job_id}/cancel")
def job_cancel(pid: str, job_id: str):
    return {"cancelled": jobs.cancel(job_id)}


# ---- Photos ----

PHOTO_FIELDS = [
    "id", "idx", "ts", "lat", "lon", "lat_orig", "lon_orig", "flags", "thumb", "sequence_id", "rank", "is_360",
    "heading", "heading_state", "heading_manual", "pos_method", "excluded",
]


@app.get("/api/projects/{pid}/photos")
def photos_list(pid: str):
    """Compact list for the map, timeline and list views (column arrays, chronological order)."""
    with db.open_project(pid) as conn:
        rows = conn.execute(
            f"""SELECT p.id, p.idx, p.ts, COALESCE(p.lat, p.lat_orig), COALESCE(p.lon, p.lon_orig), p.lat_orig,
                      p.lon_orig, p.flags, p.thumb, p.sequence_id, p.rank, p.is_360,
                      {headings.FINAL_SQL}, p.heading_auto_state, p.heading_manual, p.pos_method, p.excluded
               FROM photo p LEFT JOIN sequence s ON s.id = p.sequence_id ORDER BY p.idx"""
        ).fetchall()
    return {"fields": PHOTO_FIELDS, "rows": [list(r) for r in rows], "flags": db.FLAG_NAMES}


def _photo(conn, photo_id: int):
    row = conn.execute("SELECT * FROM photo WHERE id=?", (photo_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Photo introuvable")
    return row


@app.get("/api/projects/{pid}/photos/{photo_id}")
def photo_get(pid: str, photo_id: int):
    with db.open_project(pid) as conn:
        d = dict(_photo(conn, photo_id))
    d["heading_offset"] = d.get("heading_offset") or 0.0  # offset of the photo (whole ride or a series)
    d["heading_final"] = headings.final_heading(d["heading_manual"], d["heading_auto"], d["heading_offset"])
    d["flag_names"] = [n for f, n in db.FLAG_NAMES.items() if d["flags"] & f]
    return d


@app.get("/api/projects/{pid}/photos/{photo_id}/thumb")
def photo_thumb(pid: str, photo_id: int):
    path = db.thumbs_dir(pid) / f"{int(photo_id)}.jpg"
    if not path.exists():
        raise HTTPException(404, "Miniature pas encore générée")
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})


@app.get("/api/projects/{pid}/photos/{photo_id}/image")
def photo_image(pid: str, photo_id: int, hd: bool = False):
    with db.open_project(pid) as conn:
        path = _photo(conn, photo_id)["path"]
    if path.startswith(panoramax.PNX_PREFIX):  # picture of a Panoramax project: relayed from the instance
        try:
            data = panoramax.picture_bytes(pid, path, "hd" if hd else "sd")
        except panoramax.PanoramaxError as e:
            raise HTTPException(502, str(e))
        return Response(data, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
    if not os.path.exists(path):
        raise HTTPException(404, "Fichier source introuvable")
    return FileResponse(path, media_type="image/jpeg")


@app.get("/api/projects/{pid}/photos/{photo_id}/exif")
def photo_exif(pid: str, photo_id: int):
    with db.open_project(pid) as conn:
        path = _photo(conn, photo_id)["path"]
    if not os.path.exists(path):
        raise HTTPException(404, "Fichier source introuvable")
    return reader.dump_all(path)


# ---- Local file system (folder picker) ----


@app.get("/api/fs")
def fs_list(path: str = "~"):
    if path == "~":
        path = config.DEFAULT_DIR
    p = Path(os.path.expanduser(path)).resolve()
    if not p.is_dir():
        raise HTTPException(400, "Dossier introuvable")
    dirs, jpegs = [], 0
    try:
        for e in sorted(os.scandir(p), key=lambda e: e.name.lower()):
            if e.name.startswith("."):
                continue
            if e.is_dir(follow_symlinks=True):
                dirs.append(e.name)
            elif Path(e.name).suffix.lower() in importer.JPEG_EXT:
                jpegs += 1
    except PermissionError:
        raise HTTPException(403, "Accès refusé")
    return {"path": str(p), "parent": str(p.parent) if p.parent != p else None, "dirs": dirs, "jpeg_count": jpegs}


# ---- Frontend ----

if config.FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=config.FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(404)
        f = (config.FRONTEND_DIST / full_path).resolve()
        if full_path and f.is_file() and config.FRONTEND_DIST in f.parents:
            return FileResponse(f)
        return FileResponse(config.FRONTEND_DIST / "index.html")
