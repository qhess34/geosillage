"""Application settings (data directory, tools, defaults)."""

import os
import shutil
from pathlib import Path

DATA_DIR = Path(os.environ.get("PSS_DATA_DIR", Path.home() / ".local/share/panoramax-studio")).expanduser()
PROJECTS_DIR = DATA_DIR / "projects"
# Folder shown first by the folder pickers (in Docker: the mounted photos folder)
DEFAULT_DIR = os.environ.get("PSS_DEFAULT_DIR", "~")
EXIFTOOL = os.environ.get("PSS_EXIFTOOL", shutil.which("exiftool") or "exiftool")
FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"

# Number of worker threads for EXIF reading and thumbnails
WORKERS = max(2, min(8, os.cpu_count() or 2))
EXIF_BATCH = 250
THUMB_SIZE = (512, 256)

# Default analysis thresholds (overridable per project in settings)
DEFAULT_SETTINGS = {
    "gap_seconds": 10.0,  # capture interruption when time gap exceeds this
    "jump_speed_ms": 20.0,  # implied speed above which a GPS position is a jump (~72 km/h)
    "jump_min_m": 25.0,  # ...only if the displacement is at least this long
    "heading_min_m": 3.0,  # heading target: the next point, skipping points closer than this (stops)
    "heading_window_s": 12.0,  # ...looked for within this time window
    # Points to check (core/quality.py)
    "stop_m": 2.0,  # stop: displacement between consecutive photos below this
    "stop_min": 3,  # ...over at least this many photos
    "spacing_m": 25.0,  # long spacing between two consecutive photos
    "dop_max": 5.0,  # imprecise GPS fix above this dilution of precision
    "heading_diff": 90.0,  # manual heading this far from the computed one
}


def ensure_dirs() -> None:
    try:
        PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
        probe = PROJECTS_DIR / ".write-test"
        probe.touch()
        probe.unlink()
    except PermissionError:
        raise SystemExit(
            f"Pas de droit d'écriture dans {DATA_DIR} (utilisateur {os.getuid()}:{os.getgid()}). "
            "Avec Docker : créer les dossiers montés avant le premier lancement (mkdir -p data photos exports) "
            "et régler PUID/PGID dans .env sur leur propriétaire."
        ) from None
