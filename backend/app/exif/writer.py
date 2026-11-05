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
# XMP-GPano:PoseHeadingDegrees is the yaw for Panoramax (and Photo Sphere Viewer): angle of the image centre
# relative to GPSImgDirection, right > 0. It is written only when the user fixed the direction of travel on a photo
# (helmet camera), or to put back the original value (GoPro: 0.0); versions before 2026-11 wrongly wrote the
# heading there.
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
    "XMP-GPano:PosePitchDegrees",
    "XMP-GPano:PoseRollDegrees",
]
# Tags saved by versions that did not save pitch/roll yet (orig_tags without "_captured")
LEGACY_CAPTURED = [t for t in WRITTEN_TAGS if not t.endswith(("PosePitchDegrees", "PoseRollDegrees"))]

# The Panoramax viewer applies a 360° photo's orientation (yaw) only when pitch AND roll are both non-zero
# (getSphereCorrection of @panoramax/web-viewer; see the pan360-fixexif project): a 0 is replaced by this
# invisible angle when an orientation must be shown.
NUDGE = 0.01


@dataclass
class Edit:
    path: str
    heading: float | None = None  # final heading, degrees from true north
    lat: float | None = None  # corrected position (None = keep the current tags)
    lon: float | None = None
    speed_kmh: float | None = None  # speed along the (corrected) trajectory
    pose_heading: float | None = None  # XMP-GPano:PoseHeadingDegrees to write (None = untouched)
    pose_pitch: float | None = None  # XMP-GPano:PosePitchDegrees to write (None = untouched)
    pose_roll: float | None = None


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
    if e.pose_pitch is not None:
        args += [f"-XMP-GPano:PosePitchDegrees={e.pose_pitch}"]
    if e.pose_roll is not None:
        args += [f"-XMP-GPano:PoseRollDegrees={e.pose_roll}"]
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
    """Arguments putting back the saved values (a tag absent at the time is deleted). Only the tags that were
    captured are restored (older saves did not include pitch/roll)."""
    args = []
    for t in orig.get("_captured", LEGACY_CAPTURED):
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
    # Options apply to one command only: with -execute they must be repeated for every file. -q -q silences
    # warnings such as "[minor] Maker notes could not be parsed" (GoPro MAX): they are not write errors.
    common = ["-q", "-q", "-n", "-charset", "filename=utf8"]
    common += ["-overwrite_original_in_place", "-P"] if on_source else ["-overwrite_original"]
    with tempfile.NamedTemporaryFile("w", suffix=".args", encoding="utf-8") as f:
        for path, a in items:
            f.write("\n".join([*common, *a, path, "-execute"]) + "\n")
        f.flush()
        res = subprocess.run(
            [config.EXIFTOOL, "-q", "-q", "-@", f.name], capture_output=True, text=True, encoding="utf-8", errors="replace"
        )
    errors = {}
    # Only "Error" lines are failures (warnings may still be printed); the caller also re-reads every file
    for line in res.stderr.splitlines():
        if not line.lstrip().startswith("Error"):
            continue
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
        out[src]["_captured"] = WRITTEN_TAGS
    missing = [p for p in paths if p not in out]
    if missing:
        raise OSError(f"Lecture des métadonnées impossible : {missing[0]}")
    return out
