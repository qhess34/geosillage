"""Editing routes: sequences, headings, undo/redo, export."""

import os
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import db, exporter, jobs, undo
from .core import headings, positions, sequences, timesync

router = APIRouter(prefix="/api/projects/{pid}")


def _seq_errors(fn):
    try:
        return fn()
    except sequences.SequenceError as e:
        raise HTTPException(409, str(e))


def _state(conn) -> dict:
    return {"sequences": sequences.list_with_stats(conn), "undo": undo.state(conn)}


# ---- Sequences ----


class RangeIn(BaseModel):
    start_idx: int
    end_idx: int
    name: str | None = None


class SeqPatch(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    heading_offset: float | None = Field(default=None, ge=-360, le=360)


class BulkIn(BaseModel):
    segments: list[tuple[int, int]] = Field(min_length=1)


class IdsIn(BaseModel):
    ids: list[int] = Field(min_length=1)


@router.get("/sequences")
def seq_list(pid: str):
    with db.open_project(pid) as conn:
        return _state(conn)


@router.post("/sequences", status_code=201)
def seq_create(pid: str, body: RangeIn):
    with db.open_project(pid) as conn:
        with undo.undoable(conn, "Création de séquence"):
            res = _seq_errors(lambda: sequences.create(conn, body.start_idx, body.end_idx, body.name))
        return {**res, **_state(conn)}


@router.post("/sequences/bulk", status_code=201)
def seq_bulk(pid: str, body: BulkIn):
    with db.open_project(pid) as conn:
        with undo.undoable(conn, f"Création de {len(body.segments)} séquences"):
            res = _seq_errors(lambda: sequences.create_many(conn, body.segments))
        return {"created": res, **_state(conn)}


@router.get("/sequences/proposals")
def seq_proposals(pid: str, gap_s: float | None = None, max_dist_m: float = 100.0, min_photos: int = 5):
    with db.open_project(pid) as conn:
        return sequences.propose_cuts(conn, gap_s, max_dist_m, min_photos)


@router.patch("/sequences/{sid}")
def seq_update(pid: str, sid: int, body: SeqPatch):
    with db.open_project(pid) as conn:
        label = "Décalage de cap de séquence" if body.heading_offset is not None else "Renommage de séquence"
        with undo.undoable(conn, label):
            _seq_errors(lambda: sequences.update(conn, sid, body.name, body.heading_offset))
        return _state(conn)


@router.put("/sequences/{sid}/bounds")
def seq_bounds(pid: str, sid: int, body: RangeIn):
    with db.open_project(pid) as conn:
        with undo.undoable(conn, "Modification des limites"):
            _seq_errors(lambda: sequences.set_bounds(conn, sid, body.start_idx, body.end_idx))
        return _state(conn)


@router.delete("/sequences/{sid}")
def seq_delete(pid: str, sid: int):
    with db.open_project(pid) as conn:
        with undo.undoable(conn, "Suppression de séquence"):
            _seq_errors(lambda: sequences.delete(conn, sid))
        return _state(conn)


@router.post("/sequences/{sid}/split")
def seq_split(pid: str, sid: int, photo_id: int):
    with db.open_project(pid) as conn:
        with undo.undoable(conn, "Division de séquence"):
            new = _seq_errors(lambda: sequences.split(conn, sid, photo_id))
        return {"new_id": new, **_state(conn)}


@router.post("/sequences/merge")
def seq_merge(pid: str, body: IdsIn):
    with db.open_project(pid) as conn:
        with undo.undoable(conn, "Fusion de séquences"):
            target = _seq_errors(lambda: sequences.merge(conn, body.ids))
        return {"id": target, **_state(conn)}


@router.post("/sequences/remove-photos")
def seq_remove_photos(pid: str, body: IdsIn):
    with db.open_project(pid) as conn:
        with undo.undoable(conn, "Retrait de photos"):
            sequences.remove_photos(conn, body.ids)
        return _state(conn)


class ExcludeIn(BaseModel):
    photo_ids: list[int] | None = None
    start_idx: int | None = None
    end_idx: int | None = None
    excluded: bool = True


@router.post("/photos/exclude")
def photos_exclude(pid: str, body: ExcludeIn):
    """Exclude photos (out of sequences, never exported) or put them back. Undoable."""
    with db.open_project(pid) as conn:
        if body.photo_ids:
            ids = body.photo_ids
        elif body.start_idx is not None and body.end_idx is not None:
            ids = positions.ids_in_range(conn, body.start_idx, body.end_idx)
        else:
            raise HTTPException(400, "Indiquez des photos ou une plage")
        label = f"Exclusion de {len(ids)} photo(s)" if body.excluded else f"Réintégration de {len(ids)} photo(s)"
        with undo.undoable(conn, label):
            n = sequences.set_excluded(conn, ids, body.excluded)
        return {"changed": n, **_state(conn)}


@router.post("/sequences/from-unclassified", status_code=201)
def seq_from_unclassified(pid: str):
    with db.open_project(pid) as conn:
        with undo.undoable(conn, "Séquences créées avec les photos non classées"):
            res = _seq_errors(lambda: sequences.create_from_unclassified(conn))
        return {"created": res, **_state(conn)}


@router.post("/sequences/cut")
def sequences_cut(pid: str, photo_id: int):
    """Cut the ride at this photo (split its sequence, or create the sequence around it and split it)."""
    with db.open_project(pid) as conn:
        with undo.undoable(conn, "Découpe"):
            what = _seq_errors(lambda: sequences.cut_at(conn, photo_id))
        return {"done": what, **_state(conn)}


# ---- Undo / redo ----


@router.post("/undo")
def do_undo(pid: str):
    with db.open_project(pid) as conn:
        try:
            label = undo.undo(conn)
        except undo.NothingToDo:
            raise HTTPException(409, "Rien à annuler")
        headings.recompute(conn)
        return {"done": label, **_state(conn)}


@router.post("/redo")
def do_redo(pid: str):
    with db.open_project(pid) as conn:
        try:
            label = undo.redo(conn)
        except undo.NothingToDo:
            raise HTTPException(409, "Rien à rétablir")
        headings.recompute(conn)
        return {"done": label, **_state(conn)}


@router.get("/history")
def get_history(pid: str):
    with db.open_project(pid) as conn:
        return undo.history(conn)


# ---- Headings ----


class HeadingIn(BaseModel):
    value: float | None = Field(default=None, ge=0, lt=360)  # None = back to the computed heading


class HeadingRangeIn(BaseModel):
    start_idx: int
    end_idx: int
    mode: str = Field(pattern="^(offset|set|clear)$")
    value: float = 0.0


@router.post("/headings/recompute")
def headings_recompute(pid: str):
    with db.open_project(pid) as conn:
        headings.recompute(conn)
        conn.execute("UPDATE photo SET heading_stale = 0")
        return headings.stats(conn)


@router.put("/photos/{photo_id}/heading")
def heading_set(pid: str, photo_id: int, body: HeadingIn):
    with db.open_project(pid) as conn:
        if not conn.execute("SELECT 1 FROM photo WHERE id=?", (photo_id,)).fetchone():
            raise HTTPException(404, "Photo introuvable")
        label = "Cap manuel" if body.value is not None else "Retour au cap calculé"
        with undo.undoable(conn, label):
            conn.execute(
                "UPDATE photo SET heading_manual=?, heading_stale=0 WHERE id=?",
                (None if body.value is None else round(body.value, 2), photo_id),
            )
        return {"undo": undo.state(conn)}


class YawIn(BaseModel):
    photo_ids: list[int] | None = None
    start_idx: int | None = None
    end_idx: int | None = None
    yaw: float | None = Field(default=None, ge=-360, le=360)  # None = back to the camera's value (0)


@router.post("/headings/yaw")
def heading_yaw(pid: str, body: YawIn):
    """Angle of the image centre relative to the bike (helmet camera: where the head looks). Undoable."""
    with db.open_project(pid) as conn:
        if body.photo_ids:
            ids = body.photo_ids
        elif body.start_idx is not None and body.end_idx is not None:
            ids = positions.ids_in_range(conn, body.start_idx, body.end_idx)
        else:
            raise HTTPException(400, "Indiquez des photos ou une plage")
        v = None if body.yaw is None else round(((body.yaw + 180) % 360) - 180, 2)
        label = f"Direction du vélo fixée ({v:+g}°) sur {len(ids)} photo(s)" if v is not None else f"Lacet remis à 0 sur {len(ids)} photo(s)"
        with undo.undoable(conn, label):
            conn.executemany("UPDATE photo SET yaw_offset=? WHERE id=?", [(v, i) for i in ids])
        return {"changed": len(ids), "yaw": v, "undo": undo.state(conn)}


@router.post("/headings/range")
def heading_range(pid: str, body: HeadingRangeIn):
    """offset: add value to the final heading of each photo (stored as manual heading);
    set: same manual heading for all; clear: back to computed headings."""
    a, b = sorted((body.start_idx, body.end_idx))
    with db.open_project(pid) as conn:
        rows = conn.execute(
            f"""SELECT p.id, {headings.FINAL_SQL} AS h FROM photo p LEFT JOIN sequence s ON s.id = p.sequence_id
                WHERE p.idx BETWEEN ? AND ?""",
            (a, b),
        ).fetchall()
        labels = {"offset": f"Décalage de cap {body.value:+g}° sur une plage", "set": f"Cap {body.value:g}° sur une plage", "clear": "Retour au cap calculé sur une plage"}
        skipped = 0
        with undo.undoable(conn, labels[body.mode]):
            for r in rows:
                if body.mode == "clear":
                    v = None
                elif body.mode == "set":
                    v = round(body.value % 360, 2)
                elif r["h"] is None:
                    skipped += 1  # no heading to offset
                    continue
                else:
                    v = round((r["h"] + body.value) % 360, 2)
                conn.execute("UPDATE photo SET heading_manual=?, heading_stale=0 WHERE id=?", (v, r["id"]))
        return {"changed": len(rows) - skipped, "skipped": skipped, "undo": undo.state(conn)}


# ---- Positions ----


class PositionIn(BaseModel):
    lat: float | None = Field(default=None, ge=-90, le=90)  # None (both) = back to the original position
    lon: float | None = Field(default=None, ge=-180, le=180)


class PositionsBatchIn(BaseModel):
    photo_ids: list[int] | None = None
    start_idx: int | None = None  # or an index range
    end_idx: int | None = None
    mode: str = Field(pattern="^(offset|along|revert)$")
    east_m: float = Field(default=0.0, ge=-1000, le=1000)
    north_m: float = Field(default=0.0, ge=-1000, le=1000)
    meters: float = Field(default=0.0, ge=-1000, le=1000)


def _pos_errors(fn):
    try:
        return fn()
    except positions.PositionError as e:
        raise HTTPException(409, str(e))


@router.put("/photos/{photo_id}/position")
def position_set(pid: str, photo_id: int, body: PositionIn):
    with db.open_project(pid) as conn:
        if (body.lat is None) != (body.lon is None):
            raise HTTPException(400, "Latitude et longitude vont ensemble")
        label = "Position corrigée" if body.lat is not None else "Retour à la position d'origine"
        with undo.undoable(conn, label):
            if body.lat is None:
                positions.revert(conn, [photo_id])
            else:
                _pos_errors(lambda: positions.set_position(conn, photo_id, body.lat, body.lon))
        headings.recompute(conn, mark_stale_ids={photo_id})
        return {"undo": undo.state(conn)}


@router.post("/positions/batch")
def positions_batch(pid: str, body: PositionsBatchIn):
    with db.open_project(pid) as conn:
        if body.photo_ids:
            ids = body.photo_ids
        elif body.start_idx is not None and body.end_idx is not None:
            ids = positions.ids_in_range(conn, body.start_idx, body.end_idx)
        else:
            raise HTTPException(400, "Indiquez des photos ou une plage")
        labels = {
            "offset": f"Décalage de {len(ids)} positions ({body.east_m:+g} m E, {body.north_m:+g} m N)",
            "along": f"Déplacement de {len(ids)} positions de {body.meters:+g} m le long du trajet",
            "revert": f"Positions d'origine pour {len(ids)} photos",
        }
        skipped = 0
        with undo.undoable(conn, labels[body.mode]):
            if body.mode == "offset":
                changed = _pos_errors(lambda: positions.offset(conn, ids, body.east_m, body.north_m))
            elif body.mode == "along":
                changed, skipped = _pos_errors(lambda: positions.along(conn, ids, body.meters))
            else:
                changed = positions.revert(conn, ids)
        headings.recompute(conn, mark_stale_ids=set(ids))
        return {"changed": changed, "skipped": skipped, "undo": undo.state(conn)}


# ---- Time synchronisation (GPS delay) ----


class SyncApplyIn(BaseModel):
    offset_s: float = Field(ge=-120, le=120)
    scope: str = Field(pattern="^(all|sequence|range)$")
    sequence_id: int | None = None
    start_idx: int | None = None
    end_idx: int | None = None
    keep_manual: bool = True


class SyncPoint(BaseModel):
    photo_id: int
    offset_s: float


def _sync_errors(fn):
    try:
        return fn()
    except timesync.SyncError as e:
        raise HTTPException(409, str(e))


@router.get("/track")
def track_get(pid: str):
    """GPS track used for synchronisation: runs of [ts, lat, lon]."""
    with db.open_project(pid) as conn:
        return {"runs": [[list(p) for p in run] for run in timesync.build_track(conn)], "max_extrapolation_s": timesync.MAX_EXTRAPOLATION_S}


@router.get("/timesync/offset")
def sync_offset(pid: str, photo_id: int, lat: float, lon: float, window_s: float = 30.0):
    """Offset making the photo match (lat, lon) projected on the track."""
    with db.open_project(pid) as conn:
        row = conn.execute("SELECT ts FROM photo WHERE id=?", (photo_id,)).fetchone()
        if not row or row["ts"] is None:
            raise HTTPException(404, "Photo introuvable ou sans date")
        off, slat, slon = _sync_errors(lambda: timesync.offset_for_point(timesync.build_track(conn), row["ts"], lat, lon, window_s))
        return {"offset_s": off, "lat": slat, "lon": slon}


@router.post("/timesync/apply")
def sync_apply(pid: str, body: SyncApplyIn):
    with db.open_project(pid) as conn:
        if body.scope == "all":
            ids = [r[0] for r in conn.execute("SELECT id FROM photo")]
            where = "tout le projet"
        elif body.scope == "sequence":
            if body.sequence_id is None:
                raise HTTPException(400, "Séquence manquante")
            ids = [r[0] for r in conn.execute("SELECT id FROM photo WHERE sequence_id=?", (body.sequence_id,))]
            where = "une séquence"
        else:
            if body.start_idx is None or body.end_idx is None:
                raise HTTPException(400, "Plage manquante")
            ids = positions.ids_in_range(conn, body.start_idx, body.end_idx)
            where = "une plage"
        with undo.undoable(conn, f"Synchronisation {body.offset_s:+.1f} s sur {where}"):
            res = _sync_errors(lambda: timesync.apply(conn, body.offset_s, ids, body.keep_manual))
        headings.recompute(conn, mark_stale_ids=set(ids))
        db.set_meta(conn, "last_time_offset", body.offset_s)
        return {**res, "undo": undo.state(conn)}


@router.get("/timesync/points")
def sync_points_get(pid: str):
    with db.open_project(pid) as conn:
        return {"points": db.get_meta(conn, "sync_points", []), "last_offset_s": db.get_meta(conn, "last_time_offset")}


@router.put("/timesync/points")
def sync_points_put(pid: str, points: list[SyncPoint]):
    with db.open_project(pid) as conn:
        db.set_meta(conn, "sync_points", [p.model_dump() for p in points])
        return {"points": db.get_meta(conn, "sync_points", [])}


# ---- Export ----


class ExportIn(BaseModel):
    out_dir: str | None = None  # not used by in_place
    sequence_ids: list[int] | None = None
    panoramax_compat: bool = True
    exclude_gps_jumps: bool = True
    # copy: copies (originals untouched); move / in_place: the source photos themselves are modified
    mode: str = Field(default="copy", pattern="^(copy|move|in_place)$")


def _running(pid: str, kinds: set[str]) -> bool:
    with db.open_project(pid) as conn:
        return any(j["state"] == "running" and j["kind"] in kinds for j in jobs.list_jobs(conn, 20))


@router.post("/export", status_code=202)
def export_start(pid: str, body: ExportIn):
    out = None
    if body.mode != "in_place":
        if not body.out_dir or not body.out_dir.strip():
            raise HTTPException(400, "Dossier de destination manquant")
        out = Path(os.path.expanduser(body.out_dir)).resolve()
        if out.exists() and not out.is_dir():
            raise HTTPException(400, "Le chemin d'export n'est pas un dossier")
    with db.open_project(pid) as conn:
        if body.mode == "copy":
            # Copies inside a source folder would be imported again as new photos
            for (src,) in conn.execute("SELECT path FROM source_dir"):
                src = Path(src).resolve()
                if out == src or src in out.parents:
                    raise HTTPException(400, f"Le dossier d'export ne doit pas être dans un dossier source ({src})")
        if not conn.execute("SELECT 1 FROM sequence LIMIT 1").fetchone():
            raise HTTPException(400, "Aucune séquence à exporter")
    if _running(pid, {"export", "restore_sources", "import"}):
        raise HTTPException(409, "Une autre tâche sur les fichiers est en cours")

    def task(ctx):
        exporter.run(ctx, str(out) if out else None, body.sequence_ids, body.panoramax_compat, body.exclude_gps_jumps, body.mode)

    return {"job_id": jobs.start(pid, "export", task, unique=False), "out_dir": str(out) if out else None}


@router.get("/exports")
def export_list(pid: str):
    with db.open_project(pid) as conn:
        return exporter.list_exports(conn)


@router.get("/sources")
def sources_state(pid: str):
    """How many source photos were modified / moved by the application."""
    with db.open_project(pid) as conn:
        return exporter.modified_sources(conn)


@router.post("/sources/trash-excluded", status_code=202)
def sources_trash_excluded(pid: str):
    """Move the files of excluded photos into a `_exclues` folder next to them (restorable)."""
    with db.open_project(pid) as conn:
        n = conn.execute("SELECT COUNT(*) FROM photo WHERE excluded=1 AND path NOT LIKE '%/_exclues/%'").fetchone()[0]
    if not n:
        raise HTTPException(400, "Aucune photo exclue à déplacer")
    if _running(pid, {"export", "restore_sources", "import", "trash"}):
        raise HTTPException(409, "Une autre tâche sur les fichiers est en cours")
    return {"job_id": jobs.start(pid, "trash", exporter.trash_excluded)}


@router.post("/sources/restore", status_code=202)
def sources_restore(pid: str):
    with db.open_project(pid) as conn:
        state = exporter.modified_sources(conn)
    if not state["modified"] and not state["moved"]:
        raise HTTPException(400, "Aucune photo source modifiée")
    if _running(pid, {"export", "restore_sources", "import"}):
        raise HTTPException(409, "Une autre tâche sur les fichiers est en cours")
    return {"job_id": jobs.start(pid, "restore_sources", exporter.restore_sources)}
