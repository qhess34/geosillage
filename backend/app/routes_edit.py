"""Editing routes: sequences, headings, undo/redo, export."""

import os
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import db, exporter, jobs, undo
from .core import headings, sequences

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


# ---- Export ----


class ExportIn(BaseModel):
    out_dir: str = Field(min_length=1)
    sequence_ids: list[int] | None = None
    panoramax_compat: bool = True
    exclude_gps_jumps: bool = True


@router.post("/export", status_code=202)
def export_start(pid: str, body: ExportIn):
    out = Path(os.path.expanduser(body.out_dir)).resolve()
    with db.open_project(pid) as conn:
        for (src,) in conn.execute("SELECT path FROM source_dir"):
            src = Path(src).resolve()
            if out == src or src in out.parents:
                raise HTTPException(400, f"Le dossier d'export ne doit pas être dans un dossier source ({src})")
        if not conn.execute("SELECT 1 FROM sequence LIMIT 1").fetchone():
            raise HTTPException(400, "Aucune séquence à exporter")
    if out.exists() and not out.is_dir():
        raise HTTPException(400, "Le chemin d'export n'est pas un dossier")

    def task(ctx):
        exporter.run(ctx, str(out), body.sequence_ids, body.panoramax_compat, body.exclude_gps_jumps)

    return {"job_id": jobs.start(pid, "export", task, unique=False), "out_dir": str(out)}


@router.get("/exports")
def export_list(pid: str):
    with db.open_project(pid) as conn:
        return exporter.list_exports(conn)
