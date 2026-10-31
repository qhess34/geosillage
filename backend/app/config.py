"""Application settings (data directory, tools, defaults)."""

import os
import shutil
from pathlib import Path

DATA_DIR = Path(os.environ.get("PSS_DATA_DIR", Path.home() / ".local/share/panoramax-studio")).expanduser()
PROJECTS_DIR = DATA_DIR / "projects"
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
}


def ensure_dirs() -> None:
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
