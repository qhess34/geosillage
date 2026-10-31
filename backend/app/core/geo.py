"""Geodesic helpers on the WGS84 ellipsoid."""

from pyproj import Geod

GEOD = Geod(ellps="WGS84")


def valid_coord(lat, lon) -> bool:
    if lat is None or lon is None:
        return False
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        return False
    # (0, 0) is the classic "no fix" value written by cameras
    return not (abs(lat) < 1e-9 and abs(lon) < 1e-9)


def distance(lat1, lon1, lat2, lon2) -> float:
    """Geodesic distance in meters."""
    _, _, d = GEOD.inv(lon1, lat1, lon2, lat2)
    return d


def azimuth(lat1, lon1, lat2, lon2) -> float:
    """Forward azimuth from point 1 to point 2, degrees in [0, 360)."""
    az, _, _ = GEOD.inv(lon1, lat1, lon2, lat2)
    return az % 360.0


def distances(lats1, lons1, lats2, lons2) -> list[float]:
    """Vectorised geodesic distances (lists of equal length)."""
    if not lats1:
        return []
    _, _, d = GEOD.inv(lons1, lats1, lons2, lats2)
    return list(d)


def path_length(points: list[tuple[float, float]]) -> float:
    """Total length in meters of a (lat, lon) polyline."""
    if len(points) < 2:
        return 0.0
    a, b = points[:-1], points[1:]
    return float(sum(distances([p[0] for p in a], [p[1] for p in a], [p[0] for p in b], [p[1] for p in b])))
