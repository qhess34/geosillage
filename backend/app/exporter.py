"""Export: one folder per sequence, containing copies of the photos with corrected EXIF.

<out_dir>/<NN>_<sequence name>/<rank>_<original file name>.jpg

- The original files are only read (copied); tags are written on the copies with ExifTool,
  without re-encoding the image data.
- Every written file is read back to verify heading and position.
- Each folder gets `.pss-export.json` (marker: a later export of the same project may replace the folder)
  and `photos.csv` (original path, position, heading and their origin).
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
from .core import headings
from .exif import reader, writer

MARKER = ".pss-export.json"
BATCH = 200


class ExportError(jobs.UserError):
    pass


def slug(name: str) -> str:
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    s = re.sub(r"[^A-Za-z0-9._ -]+", "", s).strip().replace(" ", "_")
    return s[:60] or "sequence"


def _prepare_dir(path: Path, project_id: str) -> None:
    """Create the folder; an existing one is only reused if it is a previous export of this project."""
    if path.exists():
        marker = path / MARKER
        if not marker.exists():
            if any(path.iterdir()):
                raise ExportError(f"Le dossier {path} existe déjà et n'est pas un export de ce projet")
        else:
            info = json.loads(marker.read_text())
            if info.get("project_id") != project_id:
                raise ExportError(f"Le dossier {path} contient l'export d'un autre projet")
            for f in info.get("files", []):
                p = path / f
                if p.is_file():
                    p.unlink()
            for leftover in path.glob("*.tmp"):
                leftover.unlink()
    path.mkdir(parents=True, exist_ok=True)


def plan(conn, sequence_ids: list[int] | None) -> list[dict]:
    seqs = conn.execute("SELECT * FROM sequence ORDER BY id").fetchall()
    order = {r[0]: r[1] for r in conn.execute("SELECT sequence_id, MIN(idx) FROM photo WHERE sequence_id IS NOT NULL GROUP BY sequence_id")}
    seqs = sorted([s for s in seqs if s["id"] in order], key=lambda s: order[s["id"]])
    numbered = {s["id"]: i + 1 for i, s in enumerate(seqs)}
    if sequence_ids:
        seqs = [s for s in seqs if s["id"] in set(sequence_ids)]
    out = []
    for s in seqs:
        photos = conn.execute(
            f"""SELECT p.id, p.rank, p.path, p.filename, p.flags, p.lat, p.lon, p.lat_orig, p.lon_orig, p.pos_method,
                       p.heading_auto, p.heading_auto_state, p.heading_manual, {headings.FINAL_SQL} AS heading
                FROM photo p JOIN sequence s ON s.id = p.sequence_id
                WHERE p.sequence_id=? ORDER BY p.rank""",
            (s["id"],),
        ).fetchall()
        out.append({"id": s["id"], "name": s["name"], "dir": f"{numbered[s['id']]:02d}_{slug(s['name'])}", "photos": [dict(p) for p in photos]})
    return out


def run(ctx: jobs.JobContext, out_dir: str, sequence_ids: list[int] | None, panoramax_compat: bool, exclude_jumps: bool = True) -> None:
    """exclude_jumps: photos flagged as GPS jumps are left out (their position is wrong until corrected)."""
    pid = ctx.project_id
    out = Path(os.path.expanduser(out_dir)).resolve()
    with db.open_project(pid) as conn:
        headings.recompute(conn)
        work = plan(conn, sequence_ids)
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
    # Refuse before copying anything if a destination folder is not ours
    for s in work:
        _prepare_dir(out / s["dir"], pid)

    results = []
    for s in work:
        ctx.check()
        d = out / s["dir"]
        width = max(4, len(str(len(s["photos"]))))
        items = []
        for n, p in enumerate(s["photos"], 1):
            if not os.path.exists(p["path"]):
                raise ExportError(f"Fichier source introuvable : {p['path']}")
            name = f"{n:0{width}d}_{p['filename']}"  # continuous numbering keeps the order by name
            corrected = p["lat"] is not None and p["lon"] is not None
            items.append(
                {
                    **p,
                    "dest": str(d / name),
                    "name": name,
                    "write_lat": p["lat"] if corrected else None,
                    "write_lon": p["lon"] if corrected else None,
                }
            )

        def do_batch(batch):
            ctx.check()
            for it in batch:
                tmp = it["dest"] + ".tmp"
                shutil.copyfile(it["path"], tmp)
                shutil.copystat(it["path"], tmp)
                os.replace(tmp, it["dest"])
            edits = [writer.Edit(it["dest"], it["heading"], it["write_lat"], it["write_lon"]) for it in batch]
            errors = writer.write_batch(edits, panoramax_compat)
            # Verify by reading back
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
            return len(batch), problems

        problems: dict[str, str] = {}
        batches = [items[i : i + BATCH] for i in range(0, len(items), BATCH)]
        with ThreadPoolExecutor(config.WORKERS) as pool:
            for n, pb in pool.map(do_batch, batches):
                problems.update(pb)
                done += n
                ctx.progress(done, total, f"Export de « {s['name']} »")

        with open(d / "photos.csv", "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["fichier", "source", "latitude", "longitude", "position", "cap", "origine_cap"])
            for it in items:
                lat = it["lat"] if it["lat"] is not None else it["lat_orig"]
                lon = it["lon"] if it["lon"] is not None else it["lon_orig"]
                origin = (
                    "manuel" if it["heading_manual"] is not None
                    else "calculé" if it["heading"] is not None
                    else "aucun (" + (it["heading_auto_state"] or "missing") + ")"
                )
                w.writerow([
                    it["name"], it["path"], f"{lat:.8f}", f"{lon:.8f}",
                    it["pos_method"] or ("corrigée" if it["write_lat"] is not None else "originale"),
                    "" if it["heading"] is None else writer.heading_value(it["heading"], panoramax_compat),
                    origin,
                ])
        report = {
            "count": len(items),
            "with_heading": sum(1 for it in items if it["heading"] is not None),
            "without_heading": [it["name"] for it in items if it["heading"] is None],
            "corrected_positions": sum(1 for it in items if it["write_lat"] is not None),
            "excluded_gps_jumps": s["excluded"],
            "problems": problems,
            "panoramax_compat": panoramax_compat,
        }
        (d / MARKER).write_text(
            json.dumps({"project_id": pid, "sequence_id": s["id"], "exported_at": time.time(), "files": [it["name"] for it in items] + ["photos.csv"], "report": report}, ensure_ascii=False, indent=1)
        )
        with db.open_project(pid) as conn:
            conn.execute(
                "INSERT INTO export(ts, sequence_id, sequence_name, path, photo_count, report) VALUES(?, ?, ?, ?, ?, ?)",
                (time.time(), s["id"], s["name"], str(d), len(items), json.dumps(report, ensure_ascii=False)),
            )
        results.append((s["name"], len(problems)))

    bad = sum(n for _, n in results)
    ctx.progress(total, total, f"{len(results)} séquence(s) exportée(s) dans {out}" + (f" — {bad} problème(s)" if bad else ""), force=True)
    if bad:
        raise ExportError(f"{bad} fichier(s) en échec de vérification (voir l'historique des exports)")


def list_exports(conn, limit=50) -> list[dict]:
    rows = conn.execute("SELECT * FROM export ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [{**dict(r), "report": json.loads(r["report"])} for r in rows]
