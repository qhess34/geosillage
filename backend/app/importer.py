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


SAMPLE = 60  # pictures read by the preflight check of an import


class MediaError(jobs.UserError):
    """The pictures to import do not match the type of the project (or are mixed)."""


def media_name(media: str) -> str:
    return "360°" if media == "360" else "plates"


def classify(metas: list[reader.PhotoMeta], hint: str | None = None) -> tuple[str | None, bool]:
    """(type of the readable pictures: '360' / 'flat' / 'mixed' / None, needs confirmation).

    A picture is 360° when its XMP projection says so. A 2:1 picture without XMP is only a hint: it counts as flat
    unless the user confirmed `hint` = "360" (and then the confirmation is not needed any more)."""
    ok = [m for m in metas if not m.error and m.width]
    if not ok:
        return None, False
    kinds = {"360" if (m.is_360 or (m.maybe_360 and hint == "360")) else "flat" for m in ok}
    ask = hint is None and any(m.maybe_360 for m in ok)
    return ("mixed" if len(kinds) > 1 else kinds.pop()), ask


def check_media(conn, found: str | None) -> None:
    """Refuse pictures of another type than the project's (the first import sets the type)."""
    if found is None:
        return
    if found == "mixed":
        raise MediaError("Cette sélection mélange des photos 360° et des photos plates : une sortie n'a qu'un seul type de photos")
    have = db.get_meta(conn, "media")
    if have and have != found:
        raise MediaError(
            "Ce projet contient des photos {a} : on ne peut pas y importer des photos {b}. Créez une autre sortie pour ce matériel",
            a=media_name(have), b=media_name(found),
        )


def preflight(conn, roots: list[str], hint: str | None = None) -> dict:
    """Quick check before an import: type of a sample of the new pictures, refusal, confirmation needed."""
    known = {r[0] for r in conn.execute("SELECT path FROM photo")}
    new = [p for p in scan(roots) if p not in known]
    step = max(1, len(new) // SAMPLE)
    found, ask = classify(reader.read_batch(new[::step][:SAMPLE]), hint)
    check_media(conn, found)
    return {"media": found, "ask": ask and not db.get_meta(conn, "media")}


def import_paths(ctx: jobs.JobContext, roots: list[str], hint: str | None = None) -> None:
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
            is_360 = m.is_360 or (m.maybe_360 and hint == "360")
            rows.append(
                (
                    m.path, os.path.basename(m.path), size, mtime, qh, m.ts, m.ts_text, m.gps_ts,
                    m.lat, m.lon, m.alt, m.heading, m.heading_ref, m.gps_track, m.gps_dop,
                    m.make, m.model, m.width, m.height, m.projection, int(is_360), flags, m.pitch, m.roll,
                )
            )
        return metas, rows

    # Everything is read before anything is stored: a picture of the wrong type refuses the whole import
    all_metas, all_rows = [], []
    with ThreadPoolExecutor(config.WORKERS) as pool:
        for metas, rows in pool.map(process, batches):
            all_metas += metas
            all_rows.append(rows)
            done += len(rows)
            ctx.progress(done, total, "Lecture des métadonnées…")
    found, _ = classify(all_metas, hint)
    with db.open_project(pid) as conn:
        check_media(conn, found)
        with db.transaction(conn):
            if found in ("360", "flat") and not db.get_meta(conn, "media"):
                db.set_meta(conn, "media", found)
            for rows in all_rows:
                conn.executemany(
                    """INSERT OR IGNORE INTO photo(path, filename, size, mtime, qhash, ts, ts_text, gps_ts,
                       lat_orig, lon_orig, alt, heading_exif, heading_ref, gps_track, gps_dop,
                       make, model, width, height, projection, is_360, flags, pitch_orig, roll_orig)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    rows,
                )
            has = conn.execute("SELECT 1 FROM photo LIMIT 1").fetchone()
            if has and db.get_meta(conn, "heading_source") is None:  # chosen once, at the first import (then the user's choice)
                db.set_meta(conn, "heading_source", headings.detect_source(conn))
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
            if row["path"].startswith("pnx:"):  # Panoramax picture: its thumbnail is downloaded
                from . import panoramax

                (tdir / f"{row['id']}.jpg").write_bytes(panoramax.picture_bytes(pid, row["path"], "thumb"))
            else:
                make_thumbnail(row["path"], tdir / f"{row['id']}.jpg")
            return row["id"], 1
        except Exception:
            # a Panoramax picture that could not be downloaded is not unreadable: retried later (-2)
            return row["id"], -2 if row["path"].startswith("pnx:") else -1

    done = 0
    pending: list[tuple[int, int]] = []
    with db.open_project(pid) as conn, ThreadPoolExecutor(config.WORKERS) as pool:
        def flush():
            if not pending:
                return
            with db.transaction(conn):
                conn.executemany("UPDATE photo SET thumb=? WHERE id=?", [(max(s, -1), i) for i, s in pending])
                conn.executemany(
                    "UPDATE photo SET flags = flags | ? WHERE id=?",
                    [(db.UNREADABLE, i) for i, s in pending if s == -1],
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
