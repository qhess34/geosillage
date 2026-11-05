"""Per-project SQLite storage.

Each project lives in its own folder: <PROJECTS_DIR>/<id>/project.sqlite (+ thumbs/).
Source photos are only referenced by absolute path, never copied nor modified.
"""

import json
import shutil
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from . import config

# Anomaly flags (bitmask stored in photo.flags)
NO_GPS = 1
NO_DATE = 2
DUPLICATE = 4
INVALID_COORD = 8
GPS_JUMP = 16
GAP_BEFORE = 32
UNREADABLE = 64
SAME_TIME = 128
MISSING_FILE = 256

FLAG_NAMES = {
    NO_GPS: "no_gps",
    NO_DATE: "no_date",
    DUPLICATE: "duplicate",
    INVALID_COORD: "invalid_coord",
    GPS_JUMP: "gps_jump",
    GAP_BEFORE: "gap_before",
    UNREADABLE: "unreadable",
    SAME_TIME: "same_time",
    MISSING_FILE: "missing_file",
}

# Ordered migrations; index + 1 == PRAGMA user_version after applying
MIGRATIONS = [
    """
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE source_dir(path TEXT PRIMARY KEY, added_at REAL NOT NULL);
    CREATE TABLE photo(
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        filename TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime REAL NOT NULL,
        qhash TEXT,                 -- sha1(size + first/last 64 KiB): duplicate detection
        ts REAL,                    -- capture time (camera clock, seconds, naive time as UTC epoch)
        ts_text TEXT,
        gps_ts REAL,                -- GPS time (UTC epoch) when present
        lat_orig REAL, lon_orig REAL, alt REAL,
        heading_exif REAL, heading_ref TEXT, gps_track REAL, gps_dop REAL,
        make TEXT, model TEXT, width INTEGER, height INTEGER,
        projection TEXT, is_360 INTEGER NOT NULL DEFAULT 0,
        idx INTEGER,                -- chronological index within the project
        flags INTEGER NOT NULL DEFAULT 0,
        dup_of INTEGER,
        thumb INTEGER NOT NULL DEFAULT 0,   -- 0 pending, 1 done, -1 failed
        lat REAL, lon REAL, pos_method TEXT,          -- corrected position (NULL = original)
        heading_auto REAL, heading_auto_state TEXT,
        heading_manual REAL, heading_stale INTEGER NOT NULL DEFAULT 0,
        sequence_id INTEGER, rank INTEGER
    );
    CREATE INDEX photo_ts ON photo(ts, filename);
    CREATE INDEX photo_idx ON photo(idx);
    CREATE INDEX photo_qhash ON photo(qhash);
    CREATE INDEX photo_thumb ON photo(thumb);
    CREATE TABLE job(
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
        message TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL
    );
    """,
    """
    CREATE TABLE sequence(
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        heading_offset REAL NOT NULL DEFAULT 0,   -- degrees added to computed headings
        created_at REAL NOT NULL
    );
    CREATE INDEX photo_seq ON photo(sequence_id, rank);
    -- Undo/redo journal: rows changed by an operation (before/after values) + sequence table snapshots
    CREATE TABLE op_log(
        id INTEGER PRIMARY KEY,
        ts REAL NOT NULL,
        label TEXT NOT NULL,
        data TEXT NOT NULL,
        undone INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE export(
        id INTEGER PRIMARY KEY,
        ts REAL NOT NULL,
        sequence_id INTEGER,
        sequence_name TEXT NOT NULL,
        path TEXT NOT NULL,
        photo_count INTEGER NOT NULL,
        report TEXT NOT NULL
    );
    """,
    """
    -- Direct modification of source photos (user's choice): what to put back on restore
    ALTER TABLE photo ADD COLUMN orig_tags TEXT;      -- JSON of the tags' values before our first write
    ALTER TABLE photo ADD COLUMN moved_from TEXT;     -- original path when the file was moved by an export
    ALTER TABLE photo ADD COLUMN source_written_at REAL;
    ALTER TABLE export ADD COLUMN mode TEXT NOT NULL DEFAULT 'copy';
    """,
    """
    -- Time synchronisation: offset (s) used to place the photo on the GPS track (pos_method = 'time')
    ALTER TABLE photo ADD COLUMN time_offset REAL;
    """,
    """
    -- Photos excluded by the user (not in any sequence, never exported); files may be moved to a _exclues folder
    ALTER TABLE photo ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX photo_excluded ON photo(excluded);
    """,
    """
    -- Yaw (helmet camera): angle of the image centre relative to the direction of the bike, degrees, right > 0.
    -- Written to XMP-GPano:PoseHeadingDegrees (read as yaw by Panoramax); GPSImgDirection stays the bike direction.
    ALTER TABLE photo ADD COLUMN yaw_offset REAL;
    """,
    """
    -- yaw_offset follows the Panoramax viewer convention (sphereCorrection pan = yaw: the view's front shows the
    -- image at +yaw from its centre). Values fixed before used the opposite (GPano pose) convention: flip them so
    -- that what was seen in the application is what Panoramax shows. ±180 is unchanged.
    UPDATE photo SET yaw_offset = CASE WHEN -yaw_offset >= 180 THEN -yaw_offset - 360 ELSE -yaw_offset END
        WHERE yaw_offset IS NOT NULL AND abs(yaw_offset) < 180;
    """,
    """
    -- Last change of a sequence's content (photos, positions, headings, orientation, name…): re-export needed?
    ALTER TABLE sequence ADD COLUMN modified_at REAL;
    """,
    """
    -- OpenStreetMap ways downloaded for snapping (Overpass), by bounding box (rounded outwards)
    CREATE TABLE IF NOT EXISTS osm_cache(bbox TEXT PRIMARY KEY, fetched_at REAL NOT NULL, data TEXT NOT NULL);
    """,
    """
    -- Publications on a Panoramax instance (one upload set per sequence), and the published picture of each photo
    CREATE TABLE IF NOT EXISTS publication(
        id INTEGER PRIMARY KEY,
        sequence_id INTEGER NOT NULL,
        instance TEXT NOT NULL,
        upload_set_id TEXT NOT NULL,
        collection_id TEXT,
        ts REAL NOT NULL,
        photo_count INTEGER NOT NULL,
        state TEXT NOT NULL,          -- uploading, processing, ready, error
        message TEXT
    );
    CREATE TABLE IF NOT EXISTS published_photo(
        photo_id INTEGER NOT NULL,
        instance TEXT NOT NULL,
        sequence_id INTEGER NOT NULL,
        upload_set_id TEXT NOT NULL,
        picture_id TEXT,
        file_name TEXT NOT NULL,
        sent_at REAL NOT NULL,
        PRIMARY KEY (photo_id, instance)
    );
    """,
    """
    -- Corrections sent to an already published sequence: server values before / after, to put them back
    CREATE TABLE IF NOT EXISTS published_edit(
        id INTEGER PRIMARY KEY,
        sequence_id INTEGER NOT NULL,
        instance TEXT NOT NULL,
        collection_id TEXT NOT NULL,
        ts REAL NOT NULL,
        data TEXT NOT NULL,           -- [{picture_id, before: {...}, after: {...}}]
        deleted TEXT NOT NULL,        -- picture ids deleted (cannot be put back)
        reverted INTEGER NOT NULL DEFAULT 0
    );
    """,
    """
    -- Pitch / roll of a published picture (pers:pitch / pers:roll): shown by the viewer like Panoramax, never edited
    ALTER TABLE photo ADD COLUMN pitch_orig REAL;
    ALTER TABLE photo ADD COLUMN roll_orig REAL;
    """,
]

# Position flags that no longer apply once the user has set a corrected position
POSITION_FLAGS = NO_GPS | INVALID_COORD | GPS_JUMP
# SQL: flags of photo alias p with position flags cleared when corrected
EFF_FLAGS_SQL = f"(CASE WHEN p.lat IS NOT NULL THEN p.flags & ~{POSITION_FLAGS} ELSE p.flags END)"


def eff_flags(flags: int, corrected: bool) -> int:
    return flags & ~POSITION_FLAGS if corrected else flags


class ProjectNotFound(Exception):
    pass


def project_dir(project_id: str) -> Path:
    # ids are uuid hex: reject anything else to avoid path traversal
    if not project_id or not all(c in "0123456789abcdef" for c in project_id):
        raise ProjectNotFound(project_id)
    return config.PROJECTS_DIR / project_id


def db_path(project_id: str) -> Path:
    return project_dir(project_id) / "project.sqlite"


def thumbs_dir(project_id: str) -> Path:
    return project_dir(project_id) / "thumbs"


def _connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path, timeout=30, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def migrate(conn: sqlite3.Connection) -> None:
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    for i in range(version, len(MIGRATIONS)):
        conn.executescript("BEGIN;" + MIGRATIONS[i] + f"; PRAGMA user_version={i + 1}; COMMIT;")


@contextmanager
def open_project(project_id: str):
    path = db_path(project_id)
    if not path.exists():
        raise ProjectNotFound(project_id)
    conn = _connect(path)
    try:
        migrate(conn)
        yield conn
    finally:
        conn.close()


@contextmanager
def transaction(conn: sqlite3.Connection):
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")


def get_meta(conn, key, default=None):
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return json.loads(row[0]) if row else default


def set_meta(conn, key, value) -> None:
    conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)", (key, json.dumps(value)))


def get_settings(conn) -> dict:
    return {**config.DEFAULT_SETTINGS, **(get_meta(conn, "settings", {}) or {})}


PANORAMAX = "panoramax"  # project kind: sequences already published on Panoramax (no photo on disk)


def create_project(name: str, kind: str = "ride", meta: dict | None = None) -> str:
    config.ensure_dirs()
    pid = uuid.uuid4().hex
    d = project_dir(pid)
    d.mkdir(parents=True)
    (d / "thumbs").mkdir()
    conn = _connect(d / "project.sqlite")
    try:
        migrate(conn)
        set_meta(conn, "name", name)
        set_meta(conn, "created_at", time.time())
        set_meta(conn, "settings", {})
        set_meta(conn, "kind", kind)
        for k, v in (meta or {}).items():
            set_meta(conn, k, v)
    finally:
        conn.close()
    return pid


def list_projects() -> list[dict]:
    config.ensure_dirs()
    out = []
    for d in config.PROJECTS_DIR.iterdir():
        if not (d / "project.sqlite").exists():
            continue
        try:
            with open_project(d.name) as conn:
                n = conn.execute("SELECT COUNT(*) FROM photo").fetchone()[0]
                out.append(
                    {
                        "id": d.name,
                        "name": get_meta(conn, "name", d.name),
                        "created_at": get_meta(conn, "created_at", 0),
                        "photo_count": n,
                        "kind": get_meta(conn, "kind", "ride"),
                    }
                )
        except (sqlite3.DatabaseError, ProjectNotFound):
            continue
    return sorted(out, key=lambda p: p["created_at"], reverse=True)


def is_panoramax(conn) -> bool:
    return get_meta(conn, "kind", "ride") == PANORAMAX


def delete_project(project_id: str) -> None:
    """Delete the project folder (database + thumbnails). Source photos are never touched."""
    d = project_dir(project_id)
    if not (d / "project.sqlite").exists():
        raise ProjectNotFound(project_id)
    shutil.rmtree(d)
