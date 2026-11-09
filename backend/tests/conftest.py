import hashlib
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from app import config  # noqa: E402


@pytest.fixture(autouse=True)
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(config, "PROJECTS_DIR", tmp_path / "data" / "projects")
    config.ensure_dirs()
    return tmp_path / "data"


@pytest.fixture(scope="session")
def samples(tmp_path_factory) -> Path:
    """Synthetic GoPro MAX ride: 120 photos + 1 duplicate + 1 corrupted file."""
    out = tmp_path_factory.mktemp("samples") / "sortie"
    subprocess.run(
        [sys.executable, str(ROOT / "tools" / "make_samples.py"), str(out), "--count", "120", "--width", "512", "--seed", "3"],
        check=True,
        capture_output=True,
    )
    return out


def tree_hash(root: Path) -> dict[str, str]:
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.rglob("*")) if p.is_file()}


@pytest.fixture(scope="session")
def flat_samples(tmp_path_factory) -> Path:
    """Synthetic smartphone ride: flat 4:3 pictures, no GPano tags, with GPSImgDirection."""
    out = tmp_path_factory.mktemp("flat") / "sortie"
    subprocess.run(
        [sys.executable, str(ROOT / "tools" / "make_samples.py"), str(out), "--count", "40", "--width", "400", "--seed", "5", "--flat", "--compass"],
        check=True,
        capture_output=True,
    )
    return out


@pytest.fixture(scope="session")
def flat_track_samples(tmp_path_factory) -> Path:
    """Synthetic smartphone ride without GPSImgDirection (heading computed from the track)."""
    out = tmp_path_factory.mktemp("flat_track") / "sortie"
    subprocess.run(
        [sys.executable, str(ROOT / "tools" / "make_samples.py"), str(out), "--count", "40", "--width", "320", "--seed", "6", "--flat"],
        check=True,
        capture_output=True,
    )
    return out
