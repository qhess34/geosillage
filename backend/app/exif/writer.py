"""EXIF/XMP writing on *copies* with ExifTool (metadata only: the JPEG image data is never re-encoded)."""

import subprocess
import tempfile
from dataclasses import dataclass

from .. import config


@dataclass
class Edit:
    path: str
    heading: float | None = None  # final heading, degrees from true north
    lat: float | None = None  # corrected position (None = keep the original tags)
    lon: float | None = None


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
        args += [f"-GPSImgDirection={v}", "-GPSImgDirectionRef=T", f"-XMP-GPano:PoseHeadingDegrees={v}"]
    if e.lat is not None and e.lon is not None:
        args += [
            f"-GPSLatitude={abs(e.lat):.8f}",
            f"-GPSLatitudeRef={'N' if e.lat >= 0 else 'S'}",
            f"-GPSLongitude={abs(e.lon):.8f}",
            f"-GPSLongitudeRef={'E' if e.lon >= 0 else 'W'}",
        ]
    return args


def write_batch(edits: list[Edit], panoramax_compat: bool = True) -> dict[str, str]:
    """Write tags in place on the given files (which must be copies). Returns {path: error} for failures."""
    todo = [(e, tag_args(e, panoramax_compat)) for e in edits]
    todo = [(e, a) for e, a in todo if a]
    if not todo:
        return {}
    with tempfile.NamedTemporaryFile("w", suffix=".args", encoding="utf-8") as f:
        for e, a in todo:
            # -n: numeric values; -overwrite_original: the file is our own copy
            f.write("\n".join(["-n", "-overwrite_original", "-charset", "filename=utf8", *a, e.path, "-execute"]) + "\n")
        f.flush()
        res = subprocess.run(
            [config.EXIFTOOL, "-q", "-q", "-@", f.name],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    errors = {}
    if res.returncode != 0 or res.stderr.strip():
        # The caller also re-reads every written file to verify the values
        for line in res.stderr.splitlines():
            for e, _ in todo:
                if e.path in line:
                    errors[e.path] = line.strip()[:300]
    return errors
