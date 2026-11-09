"""Batch EXIF/XMP reading with ExifTool (one process per batch, never writes)."""

import json
import re
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone

from .. import config

TAGS = [
    "-FileSize#",
    "-FileModifyDate",
    "-Make",
    "-Model",
    "-ImageWidth",
    "-ImageHeight",
    "-DateTimeOriginal",
    "-SubSecTimeOriginal",
    "-SubSecDateTimeOriginal",
    "-Composite:GPSDateTime",
    "-Composite:GPSLatitude",
    "-Composite:GPSLongitude",
    "-Composite:GPSAltitude",
    "-GPSImgDirection",
    "-GPSImgDirectionRef",
    "-GPSTrack",
    "-GPSDOP",
    "-XMP-GPano:ProjectionType",
    "-XMP-GPano:UsePanoramaViewer",
    "-XMP-GPano:FullPanoWidthPixels",
    "-XMP-GPano:PosePitchDegrees",
    "-XMP-GPano:PoseRollDegrees",
]

_DT_RE = re.compile(r"^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$")


@dataclass
class PhotoMeta:
    path: str
    ts: float | None = None
    ts_text: str | None = None
    gps_ts: float | None = None
    lat: float | None = None
    lon: float | None = None
    alt: float | None = None
    heading: float | None = None
    heading_ref: str | None = None
    gps_track: float | None = None
    gps_dop: float | None = None
    make: str | None = None
    model: str | None = None
    width: int | None = None
    height: int | None = None
    projection: str | None = None
    is_360: bool = False
    maybe_360: bool = False  # 2:1 picture without GPano projection: only a hint, confirmed by the user at import
    pitch: float | None = None  # XMP-GPano pose of the file (read only)
    roll: float | None = None
    error: str | None = None


def parse_datetime(value, naive_as_utc=True) -> tuple[float | None, bool]:
    """Parse an EXIF date. Returns (epoch seconds, had_timezone).

    Camera clocks have no timezone: the naive wall-clock time is stored as if it were UTC so that
    ordering and differences are correct; the timezone offset (if any) is ignored on purpose.
    """
    if not isinstance(value, str):
        return None, False
    m = _DT_RE.match(value.strip())
    if not m:
        return None, False
    y, mo, d, h, mi, s, frac, tz = m.groups()
    try:
        dt = datetime(int(y), int(mo), int(d), int(h), int(mi), int(s), tzinfo=timezone.utc)
    except ValueError:
        return None, False
    if y == "0000":
        return None, False
    ts = dt.timestamp() + (float(frac) if frac else 0.0)
    return ts, tz is not None


def _num(v):
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def to_meta(d: dict) -> PhotoMeta:
    m = PhotoMeta(path=d["SourceFile"])
    # Capture time: prefer the composite with sub-seconds, then DateTimeOriginal + SubSecTimeOriginal
    ts, _ = parse_datetime(d.get("SubSecDateTimeOriginal"))
    if ts is None:
        ts, _ = parse_datetime(d.get("DateTimeOriginal"))
        sub = d.get("SubSecTimeOriginal")
        if ts is not None and sub not in (None, ""):
            digits = re.sub(r"\D", "", str(sub))
            if digits:
                ts += float("0." + digits)
    m.ts = ts
    m.ts_text = d.get("SubSecDateTimeOriginal") or d.get("DateTimeOriginal")
    m.gps_ts, _ = parse_datetime(d.get("GPSDateTime"))
    m.lat, m.lon, m.alt = _num(d.get("GPSLatitude")), _num(d.get("GPSLongitude")), _num(d.get("GPSAltitude"))
    m.heading = _num(d.get("GPSImgDirection"))
    m.heading_ref = d.get("GPSImgDirectionRef")
    m.gps_track = _num(d.get("GPSTrack"))
    m.gps_dop = _num(d.get("GPSDOP"))
    m.make = str(d["Make"]).strip() if d.get("Make") is not None else None
    m.model = str(d["Model"]).strip() if d.get("Model") is not None else None
    m.width = int(d["ImageWidth"]) if _num(d.get("ImageWidth")) else None
    m.height = int(d["ImageHeight"]) if _num(d.get("ImageHeight")) else None
    m.projection = d.get("ProjectionType")
    m.pitch, m.roll = _num(d.get("PosePitchDegrees")), _num(d.get("PoseRollDegrees"))
    # 360° is declared by the XMP projection (UsePanoramaViewer / FullPanoWidthPixels only support it)
    m.is_360 = m.projection == "equirectangular"
    m.maybe_360 = not m.projection and bool(m.width and m.height and m.width == 2 * m.height)
    if d.get("Error"):
        m.error = str(d["Error"])
    return m


def read_batch(paths: list[str]) -> list[PhotoMeta]:
    """Read metadata for a batch of files with a single ExifTool call."""
    if not paths:
        return []
    with tempfile.NamedTemporaryFile("w", suffix=".args", encoding="utf-8", delete=True) as args:
        args.write("\n".join(paths) + "\n")
        args.flush()
        cmd = [config.EXIFTOOL, "-json", "-n", "-fast", "-charset", "filename=utf8", *TAGS, "-@", args.name]
        res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    try:
        data = json.loads(res.stdout) if res.stdout.strip() else []
    except json.JSONDecodeError:
        data = []
    found = {d["SourceFile"]: to_meta(d) for d in data}
    out = []
    for p in paths:
        out.append(found.get(p) or PhotoMeta(path=p, error=(res.stderr.strip() or "unreadable")[:500]))
    return out


def dump_all(path: str) -> dict:
    """Full tag dump (groups, duplicates, unknown tags) for the study/inspection screen."""
    res = subprocess.run(
        [config.EXIFTOOL, "-json", "-G1", "-a", "-s", "-u", path],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    data = json.loads(res.stdout or "[{}]")
    return data[0] if data else {}
