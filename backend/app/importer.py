"""Recursive photo import: scan, quick hash, batch EXIF reading, analysis, then thumbnails."""

import hashlib
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

from . import config, db, jobs
from .core import analysis, headings
from .exif import reader

JPEG_EXT = {".jpg", ".jpeg"}
CHUNK = 64 * 1024


def scan(roots: list[str]) -> list[str]:
    """Absolute paths of JPEG files under roots (recursive, hidden folders skipped, sorted)."""
    found = set()
    for root in roots:
        root = os.path.abspath(os.path.expanduser(root))
        if os.path.isfile(root):
            if Path(root).suffix.lower() in JPEG_EXT:
                found.add(root)
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            for f in filenames:
                if not f.startswith(".") and Path(f).suffix.lower() in JPEG_EXT:
                    found.add(os.path.join(dirpath, f))
    return sorted(found)


def quick_hash(path: str) -> tuple[int, float, str]:
    """(size, mtime, sha1 of size + first and last 64 KiB). Enough to spot the same file twice."""
    st = os.stat(path)
    h = hashlib.sha1(str(st.st_size).encode())
    with open(path, "rb") as f:
        h.update(f.read(CHUNK))
        if st.st_size > 2 * CHUNK:
            f.seek(-CHUNK, os.SEEK_END)
            h.update(f.read(CHUNK))
    return st.st_size, st.st_mtime, h.hexdigest()


def import_paths(ctx: jobs.JobContext, roots: list[str]) -> None:
    pid = ctx.project_id
    ctx.progress(0, 0, "Recherche des photos…", force=True)
    paths = scan(roots)
    with db.open_project(pid) as conn:
        known = {r[0] for r in conn.execute("SELECT path FROM photo")}
        with db.transaction(conn):
            for r in roots:
                conn.execute(
                    "INSERT OR IGNORE INTO source_dir(path, added_at) VALUES(?, ?)",
                    (os.path.abspath(os.path.expanduser(r)), time.time()),
                )
    new = [p for p in paths if p not in known]
    total = len(new)
    ctx.progress(0, total, f"{total} nouvelles photos ({len(paths) - total} déjà importées)", force=True)
    if not new:
        return

    batches = [new[i : i + config.EXIF_BATCH] for i in range(0, total, config.EXIF_BATCH)]
    done = 0

    def process(batch):
        ctx.check()
        metas = reader.read_batch(batch)
        rows = []
        for m in metas:
            try:
                size, mtime, qh = quick_hash(m.path)
            except OSError as e:
                size, mtime, qh, m.error = 0, 0.0, None, str(e)
            flags = db.UNREADABLE if (m.error or not m.width) else 0
            rows.append(
                (
                    m.path, os.path.basename(m.path), size, mtime, qh, m.ts, m.ts_text, m.gps_ts,
                    m.lat, m.lon, m.alt, m.heading, m.heading_ref, m.gps_track, m.gps_dop,
                    m.make, m.model, m.width, m.height, m.projection, int(m.is_360), flags,
                )
            )
        return rows

    with db.open_project(pid) as conn, ThreadPoolExecutor(config.WORKERS) as pool:
        for rows in pool.map(process, batches):
            with db.transaction(conn):
                conn.executemany(
                    """INSERT OR IGNORE INTO photo(path, filename, size, mtime, qhash, ts, ts_text, gps_ts,
                       lat_orig, lon_orig, alt, heading_exif, heading_ref, gps_track, gps_dop,
                       make, model, width, height, projection, is_360, flags)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    rows,
                )
            done += len(rows)
            ctx.progress(done, total, "Lecture des métadonnées…")
        ctx.progress(done, total, "Analyse…", force=True)
        analysis.run(conn)
        headings.recompute(conn)
    ctx.progress(total, total, "Import terminé", force=True)
    start_thumbnails(pid)


def make_thumbnail(src: str, dst: Path) -> None:
    with Image.open(src) as im:
        im.draft("RGB", config.THUMB_SIZE)  # JPEG DCT scaling: decodes at 1/2..1/8 size, fast
        im = im.convert("RGB")
        im.thumbnail(config.THUMB_SIZE, Image.Resampling.BILINEAR)
        tmp = dst.with_suffix(".tmp")
        im.save(tmp, "JPEG", quality=78)
        os.replace(tmp, dst)


def thumbnails(ctx: jobs.JobContext) -> None:
    pid = ctx.project_id
    tdir = db.thumbs_dir(pid)
    tdir.mkdir(exist_ok=True)
    with db.open_project(pid) as conn:
        # Chronological order: the beginning of the ride gets its thumbnails first
        todo = conn.execute("SELECT id, path FROM photo WHERE thumb = 0 ORDER BY idx").fetchall()
    total = len(todo)
    ctx.progress(0, total, "Génération des miniatures…", force=True)

    def one(row):
        ctx.check()
        try:
            make_thumbnail(row["path"], tdir / f"{row['id']}.jpg")
            return row["id"], 1
        except Exception:
            return row["id"], -1

    done = 0
    pending: list[tuple[int, int]] = []
    with db.open_project(pid) as conn, ThreadPoolExecutor(config.WORKERS) as pool:
        def flush():
            if not pending:
                return
            with db.transaction(conn):
                conn.executemany("UPDATE photo SET thumb=? WHERE id=?", [(s, i) for i, s in pending])
                conn.executemany(
                    "UPDATE photo SET flags = flags | ? WHERE id=?",
                    [(db.UNREADABLE, i) for i, s in pending if s < 0],
                )
            pending.clear()

        for pid_state in pool.map(one, todo):
            pending.append(pid_state)
            done += 1
            if len(pending) >= 50:
                flush()
                ctx.progress(done, total)
        flush()
    ctx.progress(done, total, "Miniatures terminées", force=True)


def start_thumbnails(project_id: str) -> str | None:
    with db.open_project(project_id) as conn:
        if not conn.execute("SELECT 1 FROM photo WHERE thumb = 0 LIMIT 1").fetchone():
            return None
    return jobs.start(project_id, "thumbnails", thumbnails)


def check_files(ctx: jobs.JobContext) -> None:
    """Flag photos whose source file disappeared (or reappeared)."""
    pid = ctx.project_id
    with db.open_project(pid) as conn:
        rows = conn.execute("SELECT id, path FROM photo").fetchall()
        missing = {r["id"] for r in rows if not os.path.exists(r["path"])}
        with db.transaction(conn):
            conn.execute("UPDATE photo SET flags = flags & ?", (~db.MISSING_FILE,))
            conn.executemany("UPDATE photo SET flags = flags | ? WHERE id=?", [(db.MISSING_FILE, i) for i in missing])
        headings.recompute(conn)
    ctx.progress(len(rows), len(rows), f"{len(missing)} fichier(s) introuvable(s)", force=True)
