"""EXIF/XMP writing with ExifTool (metadata only: the JPEG image data is never re-encoded).

Used on export copies, and — when the user chooses it — directly on the source photos. Before the first
modification of a source photo, `read_tags` captures the current values of every tag this module may write
(`WRITTEN_TAGS`) so that `restore_args` can put them back exactly (absent tags are deleted again).
"""

import json
import subprocess
import tempfile
from dataclasses import dataclass

from .. import config

# Tags this application may write; their original values are saved before touching a source photo.
# XMP-GPano:PoseHeadingDegrees is only written back to its original value: versions before 2026-11 wrote the
# heading there, but Panoramax reads it as the yaw (rotation of the sphere relative to GPSImgDirection), and a
# correctly tagged GoPro MAX photo keeps the camera's 0.0.
WRITTEN_TAGS = [
    "EXIF:GPSVersionID",
    "EXIF:GPSLatitude",
    "EXIF:GPSLatitudeRef",
    "EXIF:GPSLongitude",
    "EXIF:GPSLongitudeRef",
    "EXIF:GPSImgDirection",
    "EXIF:GPSImgDirectionRef",
    "EXIF:GPSSpeed",
    "EXIF:GPSSpeedRef",
    "XMP-GPano:PoseHeadingDegrees",
]


@dataclass
class Edit:
    path: str
    heading: float | None = None  # final heading, degrees from true north
    lat: float | None = None  # corrected position (None = keep the current tags)
    lon: float | None = None
    speed_kmh: float | None = None  # speed along the (corrected) trajectory
    pose_heading: float | None = None  # original PoseHeadingDegrees to put back (photo modified by an older version)


def heading_value(h: float, panoramax_compat: bool) -> float:
    """Value to write. Panoramax rounds headings to integers and treats 0 as 'unset' (it recomputes it);
    with panoramax_compat a heading rounding to 0 is written as 0.6 (→ 1°) so it is kept."""
    h = round(h % 360.0, 2)
    if h >= 359.995:
        h = 0.0
    if panoramax_compat and round(h) % 360 == 0:
        return 0.6
    return h


def tag_args(e: Edit, panoramax_compat: bool) -> list[str]:
    args = []
    if e.heading is not None:
        v = heading_value(e.heading, panoramax_compat)
        args += [f"-GPSImgDirection={v}", "-GPSImgDirectionRef=T"]
    if e.speed_kmh is not None:
        args += [f"-GPSSpeed={e.speed_kmh:.2f}", "-GPSSpeedRef=K"]
    if e.pose_heading is not None:
        args += [f"-XMP-GPano:PoseHeadingDegrees={e.pose_heading}"]
    if e.lat is not None and e.lon is not None:
        args += [
            f"-GPSLatitude={abs(e.lat):.8f}",
            f"-GPSLatitudeRef={'N' if e.lat >= 0 else 'S'}",
            f"-GPSLongitude={abs(e.lon):.8f}",
            f"-GPSLongitudeRef={'E' if e.lon >= 0 else 'W'}",
        ]
    if args:
        args.append("-GPSVersionID=2 3 0 0")  # (numeric form, -n) absent from GoPro MAX photos, expected in a GPS IFD
    return args


def restore_args(orig: dict) -> list[str]:
    """Arguments putting back the saved values (a tag absent at the time is deleted)."""
    args = []
    for t in WRITTEN_TAGS:
        name = t.split(":", 1)[1]
        v = orig.get(name)
        args.append(f"-{t}={v}" if v is not None else f"-{t}=")
    return args


def run_batch(items: list[tuple[str, list[str]]], on_source: bool = False) -> dict[str, str]:
    """Run one ExifTool process writing each (path, args). Returns {path: error} for reported failures.

    on_source: the file is a user's photo: keep its file system dates (-P) and modify it in place.
    """
    items = [(p, a) for p, a in items if a]
    if not items:
        return {}
    common = ["-n", "-charset", "filename=utf8"]
    common += ["-overwrite_original_in_place", "-P"] if on_source else ["-overwrite_original"]
    with tempfile.NamedTemporaryFile("w", suffix=".args", encoding="utf-8") as f:
        for path, a in items:
            f.write("\n".join([*common, *a, path, "-execute"]) + "\n")
        f.flush()
        res = subprocess.run(
            [config.EXIFTOOL, "-q", "-q", "-@", f.name], capture_output=True, text=True, encoding="utf-8", errors="replace"
        )
    errors = {}
    if res.returncode != 0 or res.stderr.strip():
        # The caller also re-reads every written file to verify the values
        for line in res.stderr.splitlines():
            for path, _ in items:
                if path in line:
                    errors[path] = line.strip()[:300]
    return errors


def write_batch(edits: list[Edit], panoramax_compat: bool = True, on_source: bool = False) -> dict[str, str]:
    return run_batch([(e.path, tag_args(e, panoramax_compat)) for e in edits], on_source)


def read_tags(paths: list[str]) -> dict[str, dict]:
    """Current raw values (numeric) of WRITTEN_TAGS for each file: {path: {TagName: value}}."""
    if not paths:
        return {}
    with tempfile.NamedTemporaryFile("w", suffix=".args", encoding="utf-8") as f:
        f.write("\n".join(paths) + "\n")
        f.flush()
        res = subprocess.run(
            [config.EXIFTOOL, "-json", "-n", "-charset", "filename=utf8", *[f"-{t}" for t in WRITTEN_TAGS], "-@", f.name],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    data = json.loads(res.stdout) if res.stdout.strip() else []
    out = {}
    for d in data:
        src = d.pop("SourceFile")
        out[src] = {k: v for k, v in d.items() if k in {t.split(":", 1)[1] for t in WRITTEN_TAGS}}
    missing = [p for p in paths if p not in out]
    if missing:
        raise OSError(f"Lecture des métadonnées impossible : {missing[0]}")
    return out
