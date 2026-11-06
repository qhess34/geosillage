"""Editing routes: sequences, headings, undo/redo, export."""

import os
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import db, exporter, jobs, undo
from .core import gpx, headings, osm, positions, quality, sequences, timesync

router = APIRouter(prefix="/api/projects/{pid}")


def _seq_errors(fn):
    try:
        return fn()
    except sequences.SequenceError as e:
        raise HTTPException(409, str(e))


def ride_only(conn) -> None:
    """Operations on files or on the cut of sequences do not exist in a Panoramax project (published sequences)."""
    if db.is_panoramax(conn):
        raise HTTPException(409, "Impossible dans un projet Panoramax (séquences déjà publiées) : seules les corrections sont envoyées")


def _state(conn) -> dict:
    return {"sequences": sequences.list_with_stats(conn), "undo": undo.state(conn)}


# ---- Sequences ----


class RangeIn(BaseModel):
    start_idx: int
    end_idx: int
    name: str | None = None


class SeqPatch(BaseModel):
    name: str | None = Field(default=None, max_length=200)


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
        ride_only(conn)
        with undo.undoable(conn, "Création de séquence"):
            res = _seq_errors(lambda: sequences.create(conn, body.start_idx, body.end_idx, body.name))
        return {**res, **_state(conn)}


@router.post("/sequences/bulk", status_code=201)
def seq_bulk(pid: str, body: BulkIn):
    with db.open_project(pid) as conn:
        ride_only(conn)
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
        with undo.undoable(conn, "Renommage de séquence"):
            _seq_errors(lambda: sequences.update(conn, sid, body.name))
        return _state(conn)


@router.put("/sequences/{sid}/bounds")
def seq_bounds(pid: str, sid: int, body: RangeIn):
    with db.open_project(pid) as conn:
        ride_only(conn)
        with undo.undoable(conn, "Modification des limites"):
            _seq_errors(lambda: sequences.set_bounds(conn, sid, body.start_idx, body.end_idx))
        return _state(conn)


@router.delete("/sequences/{sid}")
def seq_delete(pid: str, sid: int):
    with db.open_project(pid) as conn:
        ride_only(conn)
        with undo.undoable(conn, "Suppression de séquence"):
            _seq_errors(lambda: sequences.delete(conn, sid))
        return _state(conn)


@router.post("/sequences/{sid}/split")
def seq_split(pid: str, sid: int, photo_id: int):
    with db.open_project(pid) as conn:
        ride_only(conn)
        with undo.undoable(conn, "Division de séquence"):
            new = _seq_errors(lambda: sequences.split(conn, sid, photo_id))
        return {"new_id": new, **_state(conn)}


@router.post("/sequences/merge")
def seq_merge(pid: str, body: IdsIn):
    with db.open_project(pid) as conn:
        ride_only(conn)
        with undo.undoable(conn, "Fusion de séquences"):
            target = _seq_errors(lambda: sequences.merge(conn, body.ids))
        return {"id": target, **_state(conn)}


@router.post("/sequences/remove-photos")
def seq_remove_photos(pid: str, body: IdsIn):
    with db.open_project(pid) as conn:
        ride_only(conn)
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
        ride_only(conn)
        with undo.undoable(conn, "Séquences créées avec les photos non classées"):
            res = _seq_errors(lambda: sequences.create_from_unclassified(conn))
        return {"created": res, **_state(conn)}


@router.post("/sequences/cut")
def sequences_cut(pid: str, photo_id: int):
    """Cut the ride at this photo (split its sequence, or create the sequence around it and split it)."""
    with db.open_project(pid) as conn:
        ride_only(conn)
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
    sequence_id: int | None = None
    all: bool = False  # every photo of the project (classified or not)
    yaw: float | None = Field(default=None, ge=-360, le=360)  # None = back to the camera's value (0)
    # instead of yaw: rotate by this angle, added to each photo's current value (camera mounted backwards: 180)
    add: float | None = Field(default=None, ge=-360, le=360)


def _norm180(v: float) -> float:
    return round(((v + 180) % 360) - 180, 2)


@router.post("/headings/yaw")
def heading_yaw(pid: str, body: YawIn):
    """Angle of the image centre relative to the direction of travel (XMP PoseHeadingDegrees). The JPEG is never rotated.

    yaw: set this angle (helmet camera: where the head looks); add: rotate every photo by this angle on top of
    its current value (camera mounted backwards on a whole sequence: 180). Undoable."""
    with db.open_project(pid) as conn:
        if body.all:
            ids = [r[0] for r in conn.execute("SELECT id FROM photo")]
        elif body.photo_ids:
            ids = body.photo_ids
        elif body.sequence_id is not None:
            ids = [r[0] for r in conn.execute("SELECT id FROM photo WHERE sequence_id=?", (body.sequence_id,))]
        elif body.start_idx is not None and body.end_idx is not None:
            ids = positions.ids_in_range(conn, body.start_idx, body.end_idx)
        else:
            raise HTTPException(400, "Indiquez des photos, une séquence, une plage ou toutes les photos")
        if not ids:
            raise HTTPException(400, "Aucune photo")
        if body.add is not None:
            ph = ",".join("?" * len(ids))
            rows = conn.execute(f"SELECT id, yaw_offset FROM photo WHERE id IN ({ph})", ids).fetchall()
            updates = [(_norm180((r["yaw_offset"] or 0) + body.add) or None, r["id"]) for r in rows]
            label = f"Rotation de {body.add:+g}° de {len(ids)} photo(s)"
        else:
            v = None if body.yaw is None else _norm180(body.yaw)
            updates = [(v, i) for i in ids]
            label = f"Sens de déplacement fixé ({v:+g}°) sur {len(ids)} photo(s)" if v is not None else f"Lacet remis à 0 sur {len(ids)} photo(s)"
        with undo.undoable(conn, label):
            conn.executemany("UPDATE photo SET yaw_offset=? WHERE id=?", updates)
        return {"changed": len(ids), "yaw": updates[0][0] if body.add is None else None, "undo": undo.state(conn)}


@router.post("/headings/range")
def heading_range(pid: str, body: HeadingRangeIn):
    """offset: add value to the final heading of each photo (stored as manual heading);
    set: same manual heading for all; clear: back to computed headings."""
    a, b = sorted((body.start_idx, body.end_idx))
    with db.open_project(pid) as conn:
        rows = conn.execute(
            f"""SELECT p.id, {headings.FINAL_SQL} AS h FROM photo p WHERE p.idx BETWEEN ? AND ?""",
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


class HeadingOffsetIn(BaseModel):
    value: float = Field(ge=-360, le=360)  # degrees added to the computed headings (0: none)
    all: bool = False  # the whole ride, otherwise the photos start_idx..end_idx
    start_idx: int | None = None
    end_idx: int | None = None


@router.post("/headings/offset")
def heading_offset(pid: str, body: HeadingOffsetIn):
    """Offset of the computed headings, on the whole ride or a series of photos (not tied to the sequences);
    manual headings are kept as they are."""
    v = round(((body.value + 180) % 360) - 180, 2) or None
    with db.open_project(pid) as conn:
        if body.all:
            where, args, what = "", (), "toute la sortie"
        elif body.start_idx is not None and body.end_idx is not None:
            a, b = sorted((body.start_idx, body.end_idx))
            where, args, what = "WHERE idx BETWEEN ? AND ?", (a, b), f"photos {a + 1} → {b + 1}"
        else:
            raise HTTPException(400, "Indiquez la plage de photos ou toute la sortie")
        label = f"Décalage du cap {v:+g}° ({what})" if v else f"Décalage du cap retiré ({what})"
        with undo.undoable(conn, label):
            n = conn.execute(f"UPDATE photo SET heading_offset=? {where}", (v, *args)).rowcount
        return {"changed": n, "undo": undo.state(conn)}


# ---- Positions ----


class PositionIn(BaseModel):
    lat: float | None = Field(default=None, ge=-90, le=90)  # None (both) = back to the original position
    lon: float | None = Field(default=None, ge=-180, le=180)


class PositionsBatchIn(BaseModel):
    photo_ids: list[int] | None = None
    start_idx: int | None = None  # or an index range
    end_idx: int | None = None
    mode: str = Field(pattern="^(offset|along|revert|interpolate)$")
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
                positions.attach_to_sequences(conn, [photo_id])
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
            "interpolate": f"Interpolation de {len(ids)} positions",
        }
        skipped = 0
        with undo.undoable(conn, labels[body.mode]):
            if body.mode == "offset":
                changed = _pos_errors(lambda: positions.offset(conn, ids, body.east_m, body.north_m))
            elif body.mode == "along":
                changed, skipped = _pos_errors(lambda: positions.along(conn, ids, body.meters))
            elif body.mode == "interpolate":
                changed, skipped = positions.interpolate(conn, ids)
            else:
                changed = positions.revert(conn, ids)
            attached = positions.attach_to_sequences(conn, ids)
        headings.recompute(conn, mark_stale_ids=set(ids))
        return {"changed": changed, "skipped": skipped, "attached": attached, "undo": undo.state(conn)}


@router.get("/quality")
def quality_check(pid: str):
    """Points to check before publishing (stops, spacing, GPS precision, headings): nothing is changed."""
    with db.open_project(pid) as conn:
        return quality.check(conn)


class IgnoreHeadingsIn(BaseModel):
    photo_ids: list[int] = Field(min_length=1)
    ignore: bool = True


@router.post("/quality/ignore-headings")
def quality_ignore_headings(pid: str, body: IgnoreHeadingsIn):
    """Headings to check that the user keeps (computed heading wrong, e.g. GPS lost), undoable; returns the new
    points to check and the undo state."""
    with db.open_project(pid) as conn:
        with undo.undoable(conn, "Cap gardé" if body.ignore else "Cap à nouveau signalé"):
            n = quality.keep_headings(conn, body.photo_ids, body.ignore)
        return {"changed": n, "issues": quality.check(conn), "undo": undo.state(conn)}


@router.get("/positions/missing")
def positions_missing(pid: str):
    """Blocks of photos without a position, with the positioned photos before / after them."""
    with db.open_project(pid) as conn:
        return positions.missing_runs(conn)


# ---- Snapping onto OpenStreetMap ways ----


class SnapProposeIn(BaseModel):
    start_idx: int
    end_idx: int
    max_dist: float = Field(default=osm.MAX_DIST_M, ge=2, le=50)


class SnapSegment(BaseModel):
    start_idx: int
    end_idx: int
    way_id: int


class SnapApplyIn(BaseModel):
    start_idx: int
    end_idx: int
    segments: list[SnapSegment] = Field(min_length=1)
    max_dist: float = Field(default=osm.MAX_DIST_M, ge=2, le=50)
    keep_manual: bool = True  # photos placed by hand are not snapped


def _snap_photos(conn, start_idx: int, end_idx: int) -> list[dict]:
    """Photos of the range with a usable position (effective), in ride order."""
    a, b = sorted((start_idx, end_idx))
    rows = conn.execute(
        f"""SELECT p.id, p.idx, COALESCE(p.lat, p.lat_orig) lat, COALESCE(p.lon, p.lon_orig) lon, p.pos_method
            FROM photo p WHERE p.idx BETWEEN ? AND ? AND p.excluded = 0 AND p.flags & ? = 0
              AND {positions._positioned_sql()} ORDER BY p.idx""",
        (a, b, positions.UNUSABLE),
    ).fetchall()
    return [dict(r) for r in rows]


def _snap_match(conn, photos: list[dict], max_dist: float, fetch=None) -> dict:
    if not photos:
        raise HTTPException(400, "Aucune photo positionnée dans la sélection")
    try:
        ways = osm.fetch_ways(conn, osm.bbox_of([(p["lat"], p["lon"]) for p in photos]), fetch)
    except osm.OsmError as e:
        raise HTTPException(502, str(e))
    return osm.match(photos, ways, max_dist)


@router.post("/osm/snap/propose")
def snap_propose(pid: str, body: SnapProposeIn):
    """Segments of the selection with their candidate OSM ways; nothing is modified."""
    with db.open_project(pid) as conn:
        photos = _snap_photos(conn, body.start_idx, body.end_idx)
        res = _snap_match(conn, photos, body.max_dist)
        manual = [p["id"] for p in photos if p["pos_method"] == "manual"]
        return {**res, "manual_ids": manual}


@router.post("/osm/snap/apply")
def snap_apply(pid: str, body: SnapApplyIn):
    """Photos of each segment are moved onto the chosen way (one undoable operation)."""
    with db.open_project(pid) as conn:
        photos = _snap_photos(conn, body.start_idx, body.end_idx)
        res = _snap_match(conn, photos, body.max_dist)
        proj = res["projections"]
        moved = skipped = 0
        ids = []
        with undo.undoable(conn, f"Recalage sur OpenStreetMap ({len(body.segments)} tronçon(s))"):
            for seg in body.segments:
                for p in photos:
                    if not seg.start_idx <= p["idx"] <= seg.end_idx:
                        continue
                    if body.keep_manual and p["pos_method"] == "manual":
                        skipped += 1
                        continue
                    c = proj.get(p["id"], {}).get(seg.way_id)
                    if c is None:  # this photo is too far from the chosen way
                        skipped += 1
                        continue
                    conn.execute("UPDATE photo SET lat=?, lon=?, pos_method='osm', time_offset=NULL WHERE id=?", (c[0], c[1], p["id"]))
                    ids.append(p["id"])
                    moved += 1
        headings.recompute(conn, mark_stale_ids=set(ids))
        return {"moved": moved, "skipped": skipped, "undo": undo.state(conn)}


# ---- Time synchronisation (GPS delay) ----


class SyncApplyIn(BaseModel):
    offset_s: float = Field(ge=-120, le=120)
    # from: photo start_idx to the end of the ride (offset changing during a ride: later syncs leave earlier photos alone)
    scope: str = Field(pattern="^(all|sequence|range|from)$")
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
    """GPS track used for synchronisation: runs of [ts, lat, lon] (the imported GPX when chosen, else the camera's)."""
    with db.open_project(pid) as conn:
        return {
            "runs": [[list(p) for p in run] for run in timesync.build_track(conn)],
            "max_extrapolation_s": timesync.MAX_EXTRAPOLATION_S,
            "source": "gpx" if gpx.use_gpx(conn) else "camera",
        }


# ---- GPX track (reference of the sync, or line to snap photos onto) ----


class GpxIn(BaseModel):
    path: str


class GpxPatch(BaseModel):
    in_use: bool | None = None  # reference track of the synchronisation: GPX (true) or camera (false)
    shift_s: float | None = Field(default=None, ge=-15 * 3600, le=15 * 3600)  # photo clock - UTC


class GpxSnapIn(BaseModel):
    start_idx: int
    end_idx: int
    max_dist: float = Field(default=gpx.SNAP_MAX_DIST_M, gt=0, le=200)
    keep_manual: bool = True
    preview: bool = False  # only say what would move (map preview), change nothing


@router.get("/gpx")
def gpx_get(pid: str):
    with db.open_project(pid) as conn:
        return {"gpx": gpx.summary(conn)}


@router.get("/gpx/track")
def gpx_track(pid: str):
    """The GPX line (runs of [ts, lat, lon] in the photo clock), shown on the map while snapping onto it."""
    with db.open_project(pid) as conn:
        tr = gpx.track(conn)
        if tr is None:
            raise HTTPException(404, "Aucune trace GPX importée")
        return {"runs": [[list(p) for p in run] for run in tr]}


@router.post("/gpx")
def gpx_import(pid: str, body: GpxIn):
    """Read a GPX file of this machine; the clock shift with the photos is detected; it becomes the sync reference."""
    path = Path(os.path.expanduser(body.path))
    if not path.is_file():
        raise HTTPException(400, "Fichier introuvable")
    if path.stat().st_size > gpx.MAX_FILE_BYTES:
        raise HTTPException(400, "Fichier GPX trop gros (50 Mo au plus)")
    with db.open_project(pid) as conn:
        try:
            runs = gpx.parse(path.read_bytes(), max(30.0, db.get_settings(conn)["gap_seconds"]))
        except gpx.GpxError as e:
            raise HTTPException(400, str(e))
        return {"gpx": gpx.store(conn, path.name, str(path), runs)}


@router.patch("/gpx")
def gpx_patch(pid: str, body: GpxPatch):
    with db.open_project(pid) as conn:
        g = gpx.load(conn)
        if not g:
            raise HTTPException(404, "Aucune trace GPX importée")
        if body.shift_s is not None:
            db.set_meta(conn, gpx.META, {**g, "shift_s": body.shift_s, "shift_from": "manual"})
        if body.in_use is not None:
            db.set_meta(conn, gpx.SOURCE, "gpx" if body.in_use else "camera")
        return {"gpx": gpx.summary(conn)}


@router.delete("/gpx")
def gpx_delete(pid: str):
    """Forget the GPX (photos already placed with it keep their positions)."""
    with db.open_project(pid) as conn:
        conn.execute("DELETE FROM meta WHERE key IN (?, ?)", (gpx.META, gpx.SOURCE))
        return {"gpx": None}


@router.post("/gpx/snap")
def gpx_snap(pid: str, body: GpxSnapIn):
    """Photos of the range moved onto the closest point of the GPX line, whatever the time (one undoable operation).
    Photos farther than max_dist stay where they are."""
    with db.open_project(pid) as conn:
        g = gpx.load(conn)
        if not g:
            raise HTTPException(404, "Aucune trace GPX importée")
        photos = _snap_photos(conn, body.start_idx, body.end_idx)
        if not photos:
            raise HTTPException(400, "Aucune photo positionnée dans la sélection")
        todo = [p for p in photos if not (body.keep_manual and p["pos_method"] in positions.MANUAL_METHODS and p["pos_method"] != "gpx")]
        res = gpx.snap(todo, g["runs"], body.max_dist)
        a, b = sorted((body.start_idx, body.end_idx))
        dists = [d for _, _, d in res.values()]
        stats = {
            "moved": len(res),
            "too_far": len(todo) - len(res),
            "kept_manual": len(photos) - len(todo),
            "mean_m": round(sum(dists) / len(dists), 1) if dists else 0,
            "max_m": round(max(dists), 1) if dists else 0,
        }
        if body.preview:
            at = {p["id"]: p for p in todo}
            return {**stats, "moves": [[[at[i]["lon"], at[i]["lat"]], [lon, lat]] for i, (lat, lon, _) in res.items()]}
        with undo.undoable(conn, f"Recalage sur la trace GPX (photos {a + 1} → {b + 1})"):
            for pid_, (lat, lon, _) in res.items():
                conn.execute("UPDATE photo SET lat=?, lon=?, pos_method='gpx', time_offset=NULL WHERE id=?", (lat, lon, pid_))
        headings.recompute(conn, mark_stale_ids=set(res))
        return {**stats, "undo": undo.state(conn)}


@router.get("/timesync/runs")
def sync_runs(pid: str):
    """Lots of consecutive photos synchronised with the same offset, and lots not synchronised."""
    with db.open_project(pid) as conn:
        return timesync.runs(conn)


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
        elif body.scope == "from":
            if body.start_idx is None:
                raise HTTPException(400, "Photo de départ manquante")
            ids = [r[0] for r in conn.execute("SELECT id FROM photo WHERE idx >= ?", (body.start_idx,))]
            where = f"à partir de la photo {body.start_idx + 1}"
        else:
            if body.start_idx is None or body.end_idx is None:
                raise HTTPException(400, "Plage manquante")
            ids = positions.ids_in_range(conn, body.start_idx, body.end_idx)
            where = "une plage"
        if not ids:
            raise HTTPException(400, "Aucune photo")
        with undo.undoable(conn, f"Synchronisation {body.offset_s:+.1f} s " + (where if body.scope == "from" else f"sur {where}")):
            res = _sync_errors(lambda: timesync.apply(conn, body.offset_s, ids, body.keep_manual))
            positions.attach_to_sequences(conn, ids)
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
        ride_only(conn)
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


@router.post("/sequences/{sid}/reexport", status_code=202)
def sequence_reexport(pid: str, sid: int):
    """Export this sequence again with the settings of its last export (folder, mode, options)."""
    with db.open_project(pid) as conn:
        ride_only(conn)
        last = exporter.last_exports(conn).get(sid)
        if not conn.execute("SELECT 1 FROM sequence WHERE id=?", (sid,)).fetchone():
            raise HTTPException(404, "Séquence introuvable")
    if not last:
        raise HTTPException(400, "Cette séquence n'a jamais été exportée : utilisez l'onglet Export")
    body = ExportIn(
        out_dir=last["out_dir"],
        sequence_ids=[sid],
        panoramax_compat=last["panoramax_compat"],
        exclude_gps_jumps=last["exclude_gps_jumps"],
        mode=last["mode"],
    )
    return {**export_start(pid, body), "mode": last["mode"]}


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
        ride_only(conn)
        n = conn.execute("SELECT COUNT(*) FROM photo WHERE excluded=1 AND path NOT LIKE '%/_exclues/%'").fetchone()[0]
    if not n:
        raise HTTPException(400, "Aucune photo exclue à déplacer")
    if _running(pid, {"export", "restore_sources", "import", "trash"}):
        raise HTTPException(409, "Une autre tâche sur les fichiers est en cours")
    return {"job_id": jobs.start(pid, "trash", exporter.trash_excluded)}


@router.post("/sources/restore", status_code=202)
def sources_restore(pid: str):
    with db.open_project(pid) as conn:
        ride_only(conn)
        state = exporter.modified_sources(conn)
    if not state["modified"] and not state["moved"]:
        raise HTTPException(400, "Aucune photo source modifiée")
    if _running(pid, {"export", "restore_sources", "import"}):
        raise HTTPException(409, "Une autre tâche sur les fichiers est en cours")
    return {"job_id": jobs.start(pid, "restore_sources", exporter.restore_sources)}
