"""Camera clock check: the capture time (DateTimeOriginal, camera clock) against the GPS time (GPSDateTime, UTC).

The difference `camera - UTC` is constant for a camera whose clock is right (it is the time zone) and for a clock
that is simply off; it is the camera clock that is wrong, not the positions. The shift is that difference minus the
UTC offset of the place (nearest zone of the tz database, by coordinates), e.g. +1 h 15 min when the camera was not
put back to winter time (+1 h) and drifted by 15 min. States: none (not enough data), ok, shifted (stable, at least
SHIFT_MIN_S), variable (the difference changes during the ride). Also counts the photos whose GPS time is stuck
(the position is then out of date)."""

import math
import statistics
from datetime import datetime, timezone

from .. import db
from . import geo

SHIFT_MIN_S = 60.0  # below this the shift is not worth correcting
TOLERANCE_S = 3.0  # a photo agrees with the median difference within this (seconds are rounded)
STABLE_SHARE = 0.9  # share of photos agreeing for the shift to be stable
MIN_PHOTOS = 3
_ZONE_TABS = ("/usr/share/zoneinfo/zone1970.tab", "/usr/share/lib/zoneinfo/zone1970.tab")
_zones: list | None = None


def _coord(s: str) -> float:
    """±DDMM[SS] / ±DDDMM[SS] (zone1970.tab) → degrees."""
    sign = -1 if s[0] == "-" else 1
    d = s[1:]
    deg_len = 2 if len(d) in (4, 6) else 3
    deg, mn, sec = int(d[:deg_len]), int(d[deg_len : deg_len + 2]), int(d[deg_len + 2 :] or 0)
    return sign * (deg + mn / 60 + sec / 3600)


def _load_zones() -> list:
    global _zones
    if _zones is None:
        _zones = []
        for path in _ZONE_TABS:
            try:
                with open(path, encoding="utf-8") as f:
                    for line in f:
                        if line.startswith("#") or not line.strip():
                            continue
                        _, coords, name, *_ = line.rstrip("\n").split("\t")
                        i = max(coords.rfind("+"), coords.rfind("-"))
                        _zones.append((_coord(coords[:i]), _coord(coords[i:]), name))
                break
            except (OSError, ValueError):
                _zones = []
    return _zones


def utc_offset_s(lat: float, lon: float, when: float) -> int:
    """UTC offset (s) of the place at that moment: nearest zone of the tz database, else the solar zone."""
    best = None
    for zlat, zlon, name in _load_zones():
        d = geo.distance(lat, lon, zlat, zlon)
        if best is None or d < best[0]:
            best = (d, name)
    if best:
        try:
            from zoneinfo import ZoneInfo

            off = datetime.fromtimestamp(when, timezone.utc).astimezone(ZoneInfo(best[1])).utcoffset()
            if off is not None:
                return int(off.total_seconds())
        except Exception:  # noqa: BLE001 - tz database missing: fall back
            pass
    return int(round(lon / 15.0)) * 3600


def offset_label(seconds: float) -> str:
    sign = "-" if seconds < 0 else "+"
    m = int(round(abs(seconds) / 60))
    return f"{sign}{m // 60:02d}:{m % 60:02d}"


def detect(conn) -> dict:
    rows = conn.execute(
        # Panoramax pictures (path "pnx:…") carry one UTC time for both: no camera clock to check
        "SELECT ts, gps_ts, lat_orig, lon_orig FROM photo WHERE excluded = 0 AND ts IS NOT NULL AND flags & ? = 0"
        " AND path NOT LIKE 'pnx:%' ORDER BY idx",
        (db.NO_GPS | db.INVALID_COORD | db.DUPLICATE | db.UNREADABLE,),
    ).fetchall()
    rows = [r for r in rows if r["gps_ts"] is not None and geo.valid_coord(r["lat_orig"], r["lon_orig"])]
    out = {"state": "none", "n": len(rows), "offset_s": None, "tz_s": None, "tz": None, "shift_s": None, "spread_s": None, "stuck": 0}
    if len(rows) < MIN_PHOTOS:
        return out
    diffs = [r["ts"] - r["gps_ts"] for r in rows]
    med = statistics.median(diffs)
    dev = [abs(d - med) for d in diffs]
    agree = [x for x in dev if x <= TOLERANCE_S]
    offset = int(round(med))
    mid = rows[len(rows) // 2]
    tz = utc_offset_s(mid["lat_orig"], mid["lon_orig"], mid["gps_ts"])
    # photos whose GPS time did not move although the camera clock did: stale position
    stuck = sum(1 for a, b in zip(rows, rows[1:]) if b["ts"] - a["ts"] >= 1.0 and b["gps_ts"] <= a["gps_ts"])
    shift = offset - tz
    stable = len(agree) >= STABLE_SHARE * len(rows)
    state = "variable" if not stable else ("shifted" if abs(shift) >= SHIFT_MIN_S else "ok")
    return {
        "state": state,
        "n": len(rows),
        "offset_s": offset,
        "tz_s": tz,
        "tz": offset_label(tz),
        "shift_s": shift,
        "spread_s": round(max(agree), 1) if agree else None,
        "stuck": stuck,
    }


def corrected(ts: float, info: dict) -> tuple[str, str]:
    """(DateTimeOriginal, OffsetTimeOriginal) to write for a photo of camera time `ts`: the shift removed."""
    t = math.floor(ts - info["shift_s"])
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y:%m:%d %H:%M:%S"), offset_label(info["tz_s"])
