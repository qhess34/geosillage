"""Generate a synthetic GoPro MAX-like bike ride (equirectangular JPEGs with EXIF/XMP).

Tags mimic a real GoPro MAX photo (firmware H19.03.02.06.00): Make/Model, DateTimeOriginal without sub-seconds,
GPS position/altitude/time without GPSVersionID nor GPSImgDirection, XMP-GPano with Pose*Degrees = 0.0.

The GPS written in each photo reproduces the defects described for the GoPro MAX:
 - delay: the recorded position is the true position `delay` seconds earlier (0.5-3 s, drifting),
 - noise and lateral offsets, a few GPS jumps,
 - a capture interruption, a few photos without GPS fix, one photo without date,
 - one duplicate file (same content in another folder) and one corrupted JPEG.
No GPSImgDirection is written (the application has to compute the heading).

A ground-truth CSV (true position, recorded position, delay) is written next to the photos.

Usage: python tools/make_samples.py OUT_DIR [--count 300] [--width 2048] [--seed 1]
"""

import argparse
import csv
import math
import random
import shutil
from datetime import datetime, timedelta, timezone
from fractions import Fraction
from pathlib import Path

import piexif
from PIL import Image, ImageDraw
from pyproj import Geod

GEOD = Geod(ellps="WGS84")
START = (43.6085, 3.8790)  # Montpellier
XMP = (
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
    '<rdf:Description rdf:about="" xmlns:GPano="http://ns.google.com/photos/1.0/panorama/" '
    'GPano:ProjectionType="equirectangular" GPano:UsePanoramaViewer="True" GPano:CaptureSoftware="GoPro Max" '
    'GPano:PoseHeadingDegrees="0.0" GPano:PosePitchDegrees="0.0" GPano:PoseRollDegrees="0.0" '
    'GPano:FullPanoWidthPixels="{w}" GPano:FullPanoHeightPixels="{h}" '
    'GPano:CroppedAreaImageWidthPixels="{w}" GPano:CroppedAreaImageHeightPixels="{h}" '
    'GPano:CroppedAreaLeftPixels="0" GPano:CroppedAreaTopPixels="0"/></rdf:RDF></x:xmpmeta>'
)


def rational(x, den=1000000):
    f = Fraction(abs(x)).limit_denominator(den)
    return (f.numerator, f.denominator)


def dms(deg):
    deg = abs(deg)
    d = int(deg)
    m = int((deg - d) * 60)
    s = (deg - d - m / 60) * 3600
    return ((d, 1), (m, 1), rational(s, 10000))


def route(count, rng):
    """True trajectory sampled every 0.1 s: list of (t, lat, lon). Straight legs with smooth turns."""
    pts = []
    lat, lon = START
    heading = 70.0
    target = heading
    speed = 5.0  # m/s
    t = 0.0
    duration = count * 2.2 + 400
    while t < duration:
        if rng.random() < 0.004:
            target = (heading + rng.choice([-90, -60, -30, 30, 60, 90])) % 360
        diff = (target - heading + 540) % 360 - 180
        heading = (heading + max(-4.0, min(4.0, diff))) % 360  # max 40°/s turn rate
        speed = max(2.0, min(8.0, speed + rng.uniform(-0.2, 0.2)))
        lon, lat, _ = GEOD.fwd(lon, lat, heading, speed * 0.1)
        pts.append((t, lat, lon))
        t += 0.1
    return pts


def at(pts, t):
    i = max(0, min(len(pts) - 2, int(t / 0.1)))
    (t0, la0, lo0), (t1, la1, lo1) = pts[i], pts[i + 1]
    f = (t - t0) / (t1 - t0)
    return la0 + (la1 - la0) * f, lo0 + (lo1 - lo0) * f


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--count", type=int, default=300)
    ap.add_argument("--width", type=int, default=2048)
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    out = Path(a.out)
    (out / "100GOPRO").mkdir(parents=True, exist_ok=True)
    (out / "101GOPRO").mkdir(parents=True, exist_ok=True)
    w, h = a.width, a.width // 2

    base = Image.new("RGB", (w, h))
    px = ImageDraw.Draw(base)
    for y in range(h):  # sky / ground gradient
        c = int(200 - 120 * y / h)
        px.line([(0, y), (w, y)], fill=(c // 2, c // 2 + 40, c) if y < h // 2 else (90, 80 + c // 4, 60))
    for k in range(8):  # azimuth marks
        x = k * w // 8
        px.line([(x, 0), (x, h)], fill=(255, 255, 255), width=3)

    pts = route(a.count, rng)
    t0 = datetime(2026, 6, 14, 9, 30, 0, tzinfo=timezone.utc)
    truth = []
    t = 5.0
    delay = 1.5
    pause_at = a.count // 2
    split = a.count * 2 // 3
    for i in range(a.count):
        if i == pause_at:
            t += 240.0  # camera stopped 4 minutes (capture interruption)
        t += 2.0 + rng.uniform(-0.05, 0.05)
        delay = max(0.5, min(3.0, delay + rng.uniform(-0.1, 0.1)))
        true_lat, true_lon = at(pts, t)
        rec_lat, rec_lon = at(pts, max(0.0, t - delay))
        ang, dist = rng.uniform(0, 360), abs(rng.gauss(0, 2.0))
        if 40 <= i % 97 < 46:  # lateral offset episode (parallel street)
            ang, dist = 0.0, 12.0
        rec_lon, rec_lat, _ = GEOD.fwd(rec_lon, rec_lat, ang, dist)
        jump = rng.random() < 0.01
        if jump:
            rec_lon, rec_lat, _ = GEOD.fwd(rec_lon, rec_lat, rng.uniform(0, 360), 150)
        no_fix = i < 3
        when = t0 + timedelta(seconds=t)
        folder = "100GOPRO" if i < split else "101GOPRO"
        name = f"GSAC{i + 1:04d}.JPG"

        img = base.copy()
        ImageDraw.Draw(img).text((w // 2 - 40, h // 2), f"#{i + 1}", fill=(255, 255, 0))
        zeroth = {piexif.ImageIFD.Make: b"GoPro", piexif.ImageIFD.Model: b"GoPro Max", piexif.ImageIFD.Software: b"H19.03.02.06.00"}
        exif = {}
        if i != a.count - 5:  # one picture without date
            exif[piexif.ExifIFD.DateTimeOriginal] = when.strftime("%Y:%m:%d %H:%M:%S").encode()
        gps = {}
        if not no_fix:
            gps = {
                piexif.GPSIFD.GPSLatitudeRef: b"N" if rec_lat >= 0 else b"S",
                piexif.GPSIFD.GPSLatitude: dms(rec_lat),
                piexif.GPSIFD.GPSLongitudeRef: b"E" if rec_lon >= 0 else b"W",
                piexif.GPSIFD.GPSLongitude: dms(rec_lon),
                piexif.GPSIFD.GPSAltitudeRef: 0,
                piexif.GPSIFD.GPSAltitude: rational(42 + rng.uniform(-2, 2), 100),
                piexif.GPSIFD.GPSTimeStamp: ((when.hour, 1), (when.minute, 1), (when.second, 1)),
                piexif.GPSIFD.GPSDateStamp: when.strftime("%Y:%m:%d").encode(),
                piexif.GPSIFD.GPSDOP: rational(rng.uniform(0.8, 3.0), 100),
            }
        exif_bytes = piexif.dump({"0th": zeroth, "Exif": exif, "GPS": gps})
        path = out / folder / name
        img.save(path, "JPEG", quality=80, exif=exif_bytes, xmp=XMP.format(w=w, h=h).encode())
        truth.append([f"{folder}/{name}", round(t, 3), true_lat, true_lon, None if no_fix else rec_lat, None if no_fix else rec_lon, round(delay, 2), int(jump)])

    # Duplicate file (same content imported from two folders) and a corrupted JPEG
    (out / "copie").mkdir(exist_ok=True)
    shutil.copy2(out / "100GOPRO" / "GSAC0010.JPG", out / "copie" / "GSAC0010.JPG")
    data = (out / "100GOPRO" / "GSAC0020.JPG").read_bytes()
    (out / "copie" / "GSAC9999.JPG").write_bytes(data[: len(data) // 3])

    with open(out / "verite_terrain.csv", "w", newline="") as f:
        wr = csv.writer(f)
        wr.writerow(["file", "t_s", "true_lat", "true_lon", "rec_lat", "rec_lon", "delay_s", "jump"])
        wr.writerows(truth)
    print(f"{a.count} photos in {out}")


if __name__ == "__main__":
    main()
