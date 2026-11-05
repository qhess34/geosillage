"""Export of the sequences, with corrected EXIF (heading, and position when corrected).

Three modes:

- ``copy`` (default, originals untouched): <out_dir>/<project>_<n>/<rank>_<file name>.jpg are copies
  (n = 1, 2, 3… in the order of the ride).
- ``move`` (user's choice): the *source photos* are moved into <out_dir>/<project>_<n>/ and their EXIF
  are modified in place. photo.path follows the file; photo.moved_from keeps the very first path.
- ``in_place`` (user's choice): the source photos keep their place and their EXIF are modified.

In every mode ExifTool only rewrites metadata: the image data is never re-encoded. Every written file is
read back to verify heading and position. Before the first modification of a source photo, the current
values of the tags we write are saved in photo.orig_tags; `restore_sources` puts them back and moves files
back to their original place.

Each sequence folder gets `.pss-export.json` (marker: a later export of the same project may reuse the
folder) and `photos.csv` (source path, position, heading and their origin).
"""

import csv
import json
import os
import re
import shutil
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import config, db, jobs
from .core import geo, headings
from .exif import reader, writer

MARKER = ".pss-export.json"
BATCH = 200
MODES = ("copy", "move", "in_place")


class ExportError(jobs.UserError):
    pass


def slug(name: str) -> str:
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    s = re.sub(r"[^A-Za-z0-9._ -]+", "", s).strip().replace(" ", "_")
    return s[:60] or "sequence"


def _project_paths(conn) -> set[str]:
    return {r[0] for r in conn.execute("SELECT path FROM photo")}


def _prepare_dir(path: Path, project_id: str, protected: set[str]) -> None:
    """Create the folder; an existing one is only reused if it is a previous export of this project.

    Files listed by a previous *copy* export are deleted, but never a file that is a project photo
    (after a move export the folder holds the user's photos)."""
    if path.exists():
        marker = path / MARKER
        if not marker.exists():
            if any(path.iterdir()):
                raise ExportError(f"Le dossier {path} existe déjà et n'est pas un export de ce projet")
        else:
            info = json.loads(marker.read_text())
            if info.get("project_id") != project_id:
                raise ExportError(f"Le dossier {path} contient l'export d'un autre projet")
            if info.get("mode", "copy") == "copy":
                for f in info.get("files", []):
                    p = path / f
                    if p.is_file() and str(p) not in protected:
                        p.unlink()
            for leftover in path.glob("*.tmp"):
                if str(leftover) not in protected:
                    leftover.unlink()
    path.mkdir(parents=True, exist_ok=True)


def plan(conn, sequence_ids: list[int] | None) -> list[dict]:
    seqs = conn.execute("SELECT * FROM sequence ORDER BY id").fetchall()
    order = {r[0]: r[1] for r in conn.execute("SELECT sequence_id, MIN(idx) FROM photo WHERE sequence_id IS NOT NULL GROUP BY sequence_id")}
    seqs = sorted([s for s in seqs if s["id"] in order], key=lambda s: order[s["id"]])
    numbered = {s["id"]: i + 1 for i, s in enumerate(seqs)}
    project = slug(db.get_meta(conn, "name", "projet") or "projet")
    if sequence_ids:
        seqs = [s for s in seqs if s["id"] in set(sequence_ids)]
    out = []
    for s in seqs:
        photos = conn.execute(
            f"""SELECT p.id, p.rank, p.ts, p.path, p.filename, p.flags, p.lat, p.lon, p.lat_orig, p.lon_orig, p.pos_method,
                       p.heading_auto, p.heading_auto_state, p.heading_manual, p.orig_tags, p.moved_from, p.yaw_offset,
                       {headings.FINAL_SQL} AS heading
                FROM photo p JOIN sequence s ON s.id = p.sequence_id
                WHERE p.sequence_id=? ORDER BY p.rank""",
            (s["id"],),
        ).fetchall()
        # folder: <project name>_<n>, n = 1, 2, 3… in the order of the ride
        out.append({"id": s["id"], "name": s["name"], "dir": f"{project}_{numbered[s['id']]}", "photos": [dict(p) for p in photos]})
    return out


def speeds_kmh(items: list[dict], max_dt: float = 10.0, max_kmh: float = 150.0) -> list[float | None]:
    """Speed of each photo along the exported trajectory: distance between its neighbours / time between them.
    Neighbours further than max_dt seconds (interruption) are ignored; implausible speeds are not written."""
    pos = [
        (it["ts"], it["lat"] if it["lat"] is not None else it["lat_orig"], it["lon"] if it["lon"] is not None else it["lon_orig"])
        for it in items
    ]
    out: list[float | None] = []
    for i, (t, la, lo) in enumerate(pos):
        a = pos[i - 1] if i > 0 else None
        b = pos[i + 1] if i + 1 < len(pos) else None
        a = a if a and t is not None and a[0] is not None and 0 < t - a[0] <= max_dt and a[1] is not None else None
        b = b if b and t is not None and b[0] is not None and 0 < b[0] - t <= max_dt and b[1] is not None else None
        p, q = (a or (t, la, lo)), (b or (t, la, lo))
        if p[0] is None or q[0] is None or q[0] - p[0] <= 0 or la is None:
            out.append(None)
            continue
        v = geo.distance(p[1], p[2], q[1], q[2]) / (q[0] - p[0]) * 3.6
        out.append(round(v, 2) if v <= max_kmh else None)
    return out


def _save_orig_tags(pid: str, items: list[dict]) -> None:
    """Before modifying source photos: save the current values of the tags we write (first time only)."""
    todo = [it for it in items if it["orig_tags"] is None]
    for i in range(0, len(todo), BATCH):
        part = todo[i : i + BATCH]
        tags = writer.read_tags([it["path"] for it in part])
        with db.open_project(pid) as conn, db.transaction(conn):
            for it in part:
                it["orig_tags"] = json.dumps(tags[it["path"]])
                conn.execute("UPDATE photo SET orig_tags=? WHERE id=? AND orig_tags IS NULL", (it["orig_tags"], it["id"]))


def _move_files(pid: str, items: list[dict]) -> None:
    """Move source photos to their destination; two passes through temporary names so that renumbering
    inside a folder never overwrites a file. photo.path is updated after every rename."""
    todo = [it for it in items if os.path.abspath(it["path"]) != os.path.abspath(it["dest"])]
    for it in todo:
        if os.path.exists(it["dest"]) and it["dest"] not in {x["path"] for x in todo}:
            raise ExportError(f"Un fichier existe déjà : {it['dest']}")
    with db.open_project(pid) as conn:
        for phase in ("tmp", "final"):
            with db.transaction(conn):
                for it in todo:
                    src = it["path"]
                    dst = str(Path(it["dest"]).parent / f".pss-move-{it['id']}.tmp") if phase == "tmp" else it["dest"]
                    shutil.move(src, dst)
                    if it["moved_from"] is None:
                        it["moved_from"] = src
                        conn.execute("UPDATE photo SET moved_from=? WHERE id=? AND moved_from IS NULL", (src, it["id"]))
                    conn.execute("UPDATE photo SET path=? WHERE id=?", (dst, it["id"]))
                    it["path"] = dst


def run(
    ctx: jobs.JobContext,
    out_dir: str | None,
    sequence_ids: list[int] | None,
    panoramax_compat: bool,
    exclude_jumps: bool = True,
    mode: str = "copy",
) -> None:
    """exclude_jumps: photos flagged as GPS jumps are left out (their position is wrong until corrected)."""
    if mode not in MODES:
        raise ExportError(f"Mode inconnu : {mode}")
    pid = ctx.project_id
    on_source = mode != "copy"
    out = Path(os.path.expanduser(out_dir)).resolve() if out_dir else None
    if out is None and mode != "in_place":
        raise ExportError("Dossier de destination manquant")
    with db.open_project(pid) as conn:
        headings.recompute(conn)
        work = plan(conn, sequence_ids)
        protected = _project_paths(conn)
    if not work:
        raise ExportError("Aucune séquence à exporter")
    for s in work:
        # A GPS jump whose position has been corrected is exported normally
        drop = {p["id"] for p in s["photos"] if exclude_jumps and p["flags"] & db.GPS_JUMP and p["lat"] is None}
        s["excluded"] = [p["filename"] for p in s["photos"] if p["id"] in drop]
        s["photos"] = [p for p in s["photos"] if p["id"] not in drop]
    total = sum(len(s["photos"]) for s in work)
    done = 0
    ctx.progress(0, total, "Préparation de l'export…", force=True)
    if out is not None:
        # Refuse before touching anything if a destination folder is not ours
        for s in work:
            _prepare_dir(out / s["dir"], pid, protected)

    results = []
    for s in work:
        ctx.check()
        d = out / s["dir"] if out is not None else None
        width = max(4, len(str(len(s["photos"]))))
        items = []
        for n, p in enumerate(s["photos"], 1):
            if not os.path.exists(p["path"]):
                raise ExportError(f"Fichier source introuvable : {p['path']}")
            original_name = os.path.basename(p["moved_from"] or p["path"])
            name = f"{n:0{width}d}_{original_name}"  # continuous numbering keeps the order by name
            corrected = p["lat"] is not None and p["lon"] is not None
            items.append(
                {
                    **p,
                    "dest": str(d / name) if d is not None else p["path"],
                    "name": name if d is not None else os.path.basename(p["path"]),
                    "write_lat": p["lat"] if corrected else None,
                    "write_lon": p["lon"] if corrected else None,
                }
            )

        for it, v in zip(items, speeds_kmh(items)):
            it["speed"] = v
        if on_source:
            ctx.progress(done, total, f"Sauvegarde des métadonnées d'origine (« {s['name']} »)", force=True)
            _save_orig_tags(pid, items)
        if mode == "move":
            ctx.progress(done, total, f"Déplacement des photos de « {s['name']} »", force=True)
            _move_files(pid, items)

        def do_batch(batch):
            ctx.check()
            if mode == "copy":
                for it in batch:
                    tmp = it["dest"] + ".tmp"
                    shutil.copyfile(it["path"], tmp)
                    shutil.copystat(it["path"], tmp)
                    os.replace(tmp, it["dest"])
            poses = {it["dest"]: _pose_heading(it) for it in batch}
            # An orientation is only shown by Panoramax if pitch and roll are both non-zero: read the current
            # values of the files that get one, a 0 (GoPro) becomes writer.NUDGE
            oriented = [d for d, v in poses.items() if v not in (None, 0)]
            current = writer.read_tags(oriented) if oriented else {}
            edits = []
            for it in batch:
                pitch, roll = _pose_pitch_roll(it, poses[it["dest"]], current.get(it["dest"]))
                edits.append(
                    writer.Edit(it["dest"], it["heading"], it["write_lat"], it["write_lon"], it["speed"], poses[it["dest"]], pitch, roll)
                )
            errors = writer.write_batch(edits, panoramax_compat, on_source=on_source)
            check = {m.path: m for m in reader.read_batch([it["dest"] for it in batch])}
            problems = dict(errors)
            for it in batch:
                m = check.get(it["dest"])
                if m is None or m.error:
                    problems[it["dest"]] = "relecture impossible"
                    continue
                if it["heading"] is not None:
                    want = writer.heading_value(it["heading"], panoramax_compat)
                    if m.heading is None or abs(((m.heading - want) + 180) % 360 - 180) > 0.01:
                        problems[it["dest"]] = f"cap relu {m.heading} au lieu de {want}"
                if it["write_lat"] is not None and (
                    m.lat is None or abs(m.lat - it["write_lat"]) > 1e-7 or abs(m.lon - it["write_lon"]) > 1e-7
                ):
                    problems[it["dest"]] = "position relue différente"
            if on_source:
                with db.open_project(pid) as conn:
                    conn.executemany(
                        "UPDATE photo SET source_written_at=? WHERE id=?",
                        [(time.time(), it["id"]) for it in batch if it["dest"] not in problems],
                    )
            return len(batch), problems

        problems: dict[str, str] = {}
        batches = [items[i : i + BATCH] for i in range(0, len(items), BATCH)]
        with ThreadPoolExecutor(config.WORKERS) as pool:
            for n, pb in pool.map(do_batch, batches):
                problems.update(pb)
                done += n
                ctx.progress(done, total, f"Export de « {s['name']} »")

        foreign = []
        if d is not None:
            names = {it["name"] for it in items}
            foreign = sorted(f.name for f in d.iterdir() if f.suffix.lower() in (".jpg", ".jpeg") and f.name not in names)
            _write_csv(d / "photos.csv", items, panoramax_compat)
        report = {
            "count": len(items),
            "with_heading": sum(1 for it in items if it["heading"] is not None),
            "without_heading": [it["name"] for it in items if it["heading"] is None],
            "corrected_positions": sum(1 for it in items if it["write_lat"] is not None),
            "excluded_gps_jumps": s["excluded"],
            "foreign_files": foreign,
            "problems": problems,
            "panoramax_compat": panoramax_compat,
            "exclude_gps_jumps": exclude_jumps,
            "out_dir": str(out) if out is not None else None,
            "mode": mode,
            # exported file of each photo (publication on Panoramax)
            "items": [{"photo_id": it["id"], "file": it["dest"]} for it in items],
        }
        if d is not None:
            files = [it["name"] for it in items] + ["photos.csv"]
            (d / MARKER).write_text(
                json.dumps({"project_id": pid, "sequence_id": s["id"], "mode": mode, "exported_at": time.time(), "files": files, "report": report}, ensure_ascii=False, indent=1)
            )
        with db.open_project(pid) as conn:
            conn.execute(
                "INSERT INTO export(ts, sequence_id, sequence_name, path, photo_count, report, mode) VALUES(?, ?, ?, ?, ?, ?, ?)",
                (time.time(), s["id"], s["name"], str(d) if d is not None else "(photos sources, sur place)", len(items), json.dumps(report, ensure_ascii=False), mode),
            )
        results.append((s["name"], len(problems)))

    bad = sum(n for _, n in results)
    where = f" dans {out}" if out is not None else " (sur place)"
    ctx.progress(total, total, f"{len(results)} séquence(s) exportée(s){where}" + (f" — {bad} problème(s)" if bad else ""), force=True)
    if bad:
        raise ExportError(f"{bad} fichier(s) en échec de vérification (voir l'historique des exports)")


def _pose_pitch_roll(it: dict, pose_heading: float | None, current: dict | None) -> tuple[float | None, float | None]:
    """PosePitchDegrees / PoseRollDegrees to write (None = untouched).

    - an orientation is written: a 0 (or absent) pitch / roll becomes NUDGE, otherwise untouched;
    - no orientation but the source was modified before: its original values are put back (if they were saved)."""
    if pose_heading not in (None, 0):
        cur = current or {}
        return tuple(writer.NUDGE if not cur.get(k) else None for k in ("PosePitchDegrees", "PoseRollDegrees"))
    if it.get("orig_tags"):
        orig = json.loads(it["orig_tags"])
        if "XMP-GPano:PosePitchDegrees" in orig.get("_captured", []):
            return orig.get("PosePitchDegrees"), orig.get("PoseRollDegrees")
    return None, None


def _pose_heading(it: dict) -> float | None:
    """Value for XMP-GPano:PoseHeadingDegrees (yaw for Panoramax), or None to leave the tag untouched.

    - yaw fixed by the user (helmet camera): that angle, in [0, 360);
    - otherwise, for a source photo already modified by the application: its original value (0.0 on the GoPro),
      which also undoes a yaw written by a previous export or the heading written by versions before 2026-11."""
    if it.get("yaw_offset") is not None:
        return round(it["yaw_offset"] % 360.0, 2)
    if not it.get("orig_tags"):
        return None
    return json.loads(it["orig_tags"]).get("PoseHeadingDegrees")


def _write_csv(path: Path, items: list[dict], panoramax_compat: bool) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["fichier", "source", "latitude", "longitude", "position", "cap", "origine_cap", "lacet"])
        for it in items:
            lat = it["lat"] if it["lat"] is not None else it["lat_orig"]
            lon = it["lon"] if it["lon"] is not None else it["lon_orig"]
            origin = (
                "manuel" if it["heading_manual"] is not None
                else "calculé" if it["heading"] is not None
                else "aucun (" + (it["heading_auto_state"] or "missing") + ")"
            )
            w.writerow([
                it["name"], it["moved_from"] or it["path"],
                "" if lat is None else f"{lat:.8f}", "" if lon is None else f"{lon:.8f}",
                it["pos_method"] or "originale",
                "" if it["heading"] is None else writer.heading_value(it["heading"], panoramax_compat),
                origin,
                "" if it["yaw_offset"] is None else it["yaw_offset"],
            ])


TRASH_DIR = "_exclues"


def trash_excluded(ctx: jobs.JobContext) -> None:
    """Move the files of excluded photos to <their folder>/_exclues/ (photo.moved_from keeps the original path,
    so « Restaurer les photos sources » puts them back). Nothing is ever deleted."""
    pid = ctx.project_id
    with db.open_project(pid) as conn:
        rows = [dict(r) for r in conn.execute(
            "SELECT id, path, moved_from FROM photo WHERE excluded=1 AND path NOT LIKE ? ORDER BY idx", (f"%/{TRASH_DIR}/%",)
        )]
    total = len(rows)
    ctx.progress(0, total, "Déplacement des photos exclues…", force=True)
    moved, problems = 0, []
    with db.open_project(pid) as conn:
        for i, r in enumerate(rows):
            ctx.check()
            src = Path(r["path"])
            if not src.exists():
                problems.append(f"{src} introuvable")
                continue
            dst = src.parent / TRASH_DIR / src.name
            if dst.exists():
                problems.append(f"{dst} existe déjà")
                continue
            dst.parent.mkdir(exist_ok=True)
            shutil.move(str(src), str(dst))
            with db.transaction(conn):
                conn.execute(
                    "UPDATE photo SET path=?, moved_from=COALESCE(moved_from, ?) WHERE id=?", (str(dst), str(src), r["id"])
                )
            moved += 1
            ctx.progress(i + 1, total)
    ctx.progress(total, total, f"{moved} photo(s) exclue(s) déplacée(s) dans {TRASH_DIR}/" + (f", {len(problems)} en échec" if problems else ""), force=True)
    if problems:
        raise ExportError(f"{len(problems)} photo(s) non déplacée(s), par ex. {problems[0]}")


def modified_sources(conn) -> dict:
    r = conn.execute(
        "SELECT SUM(orig_tags IS NOT NULL AND source_written_at IS NOT NULL), SUM(moved_from IS NOT NULL) FROM photo"
    ).fetchone()
    trashed = conn.execute("SELECT COUNT(*) FROM photo WHERE path LIKE ?", (f"%/{TRASH_DIR}/%",)).fetchone()[0]
    return {"modified": r[0] or 0, "moved": r[1] or 0, "trashed": trashed}


def restore_sources(ctx: jobs.JobContext) -> None:
    """Put back the saved tag values in the source photos and move them back to their original place."""
    pid = ctx.project_id
    with db.open_project(pid) as conn:
        rows = [dict(r) for r in conn.execute(
            "SELECT id, path, orig_tags, moved_from FROM photo WHERE orig_tags IS NOT NULL OR moved_from IS NOT NULL ORDER BY idx"
        )]
    total = len(rows)
    ctx.progress(0, total, "Restauration des photos sources…", force=True)
    problems: dict[str, str] = {}
    done = 0
    for i in range(0, total, BATCH):
        ctx.check()
        part = rows[i : i + BATCH]
        missing = [r for r in part if not os.path.exists(r["path"])]
        for r in missing:
            problems[r["path"]] = "fichier introuvable"
        part = [r for r in part if os.path.exists(r["path"])]
        tagged = [r for r in part if r["orig_tags"]]
        errors = writer.run_batch([(r["path"], writer.restore_args(json.loads(r["orig_tags"]))) for r in tagged], on_source=True)
        problems.update(errors)
        # Verify: the written tags are back to their saved values
        now = writer.read_tags([r["path"] for r in tagged]) if tagged else {}
        for r in tagged:
            want = json.loads(r["orig_tags"])
            got = now.get(r["path"], {})
            for k in (t.split(":", 1)[1] for t in want.get("_captured", writer.LEGACY_CAPTURED)):
                a, b = want.get(k), got.get(k)
                if not (a == b or (isinstance(a, (int, float)) and isinstance(b, (int, float)) and abs(a - b) < 1e-6)):
                    problems[r["path"]] = f"{k} : {b} au lieu de {a}"
        with db.open_project(pid) as conn, db.transaction(conn):
            for r in part:
                if r["path"] in problems:
                    continue
                if r["orig_tags"]:
                    conn.execute("UPDATE photo SET orig_tags=NULL, source_written_at=NULL WHERE id=?", (r["id"],))
                if r["moved_from"]:
                    if os.path.exists(r["moved_from"]):
                        problems[r["path"]] = f"impossible de remettre en place : {r['moved_from']} existe déjà"
                        continue
                    os.makedirs(os.path.dirname(r["moved_from"]), exist_ok=True)
                    shutil.move(r["path"], r["moved_from"])
                    conn.execute("UPDATE photo SET path=?, moved_from=NULL WHERE id=?", (r["moved_from"], r["id"]))
        done += len(part) + len(missing)
        ctx.progress(done, total)
    ctx.progress(total, total, f"{total - len(problems)} photo(s) restaurée(s)" + (f", {len(problems)} en échec" if problems else ""), force=True)
    if problems:
        first = next(iter(problems.items()))
        raise ExportError(f"{len(problems)} photo(s) non restaurée(s), par ex. {first[0]} : {first[1]}")


def last_exports(conn) -> dict[int, dict]:
    """Latest export of each sequence: {sequence_id: {ts, path, mode, out_dir, panoramax_compat, exclude_gps_jumps}}."""
    out = {}
    for r in conn.execute(
        "SELECT * FROM export e WHERE id = (SELECT MAX(id) FROM export WHERE sequence_id = e.sequence_id)"
    ):
        rep_ = json.loads(r["report"])
        out[r["sequence_id"]] = {
            "ts": r["ts"],
            "path": r["path"],
            "mode": r["mode"],
            "out_dir": rep_.get("out_dir") or (str(Path(r["path"]).parent) if r["mode"] != "in_place" else None),
            "panoramax_compat": rep_.get("panoramax_compat", True),
            "exclude_gps_jumps": rep_.get("exclude_gps_jumps", True),
            "problems": len(rep_.get("problems", {})),
        }
    return out


def list_exports(conn, limit=50) -> list[dict]:
    rows = conn.execute("SELECT * FROM export ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [{**dict(r), "report": json.loads(r["report"])} for r in rows]
