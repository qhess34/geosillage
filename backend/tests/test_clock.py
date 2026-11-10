"""Camera clock shift: detection from GPSDateTime, correction of DateTimeOriginal at export, restoration."""

import subprocess
import sys

import pytest
from fastapi.testclient import TestClient

from app import db, main
from app.exif import reader, writer

from .conftest import ROOT
from .test_import import wait_jobs

PARIS_SUMMER = 7200  # 2026-06-14 in the samples, near Montpellier
SHIFT = 4507  # 1 h 15 min 07 s ahead of the local time


def make(tmp_path_factory, name, *extra):
    out = tmp_path_factory.mktemp(name) / "sortie"
    subprocess.run(
        [sys.executable, str(ROOT / "tools" / "make_samples.py"), str(out), "--count", "80" if "--stuck-gps-time" in extra else "40", "--width", "320", "--seed", "4", *extra],
        check=True,
        capture_output=True,
    )
    return out


@pytest.fixture(scope="module")
def shifted(tmp_path_factory):
    return make(tmp_path_factory, "shifted", "--clock-shift", str(PARIS_SUMMER + SHIFT))


@pytest.fixture(scope="module")
def right(tmp_path_factory):
    return make(tmp_path_factory, "right", "--clock-shift", str(PARIS_SUMMER))


@pytest.fixture(scope="module")
def stuck(tmp_path_factory):
    return make(tmp_path_factory, "stuck", "--clock-shift", str(PARIS_SUMMER), "--stuck-gps-time")


def open_project(client, folder):
    pid = client.post("/api/projects", json={"name": "Horloge"}).json()["id"]
    client.post(f"/api/projects/{pid}/import", json={"paths": [str(folder)]})
    wait_jobs(client, pid)
    return pid


def clock_of(client, pid):
    return client.get(f"/api/projects/{pid}").json()["summary"]["clock"]


def test_detects_shift_and_zone(shifted):
    with TestClient(main.app) as client:
        c = clock_of(client, open_project(client, shifted))
    assert c["state"] == "shifted" and abs(c["shift_s"] - SHIFT) <= 1
    assert c["tz"] == "+02:00" and c["tz_s"] == PARIS_SUMMER and c["spread_s"] <= 3


def test_right_clock_is_not_flagged(right):
    with TestClient(main.app) as client:
        c = clock_of(client, open_project(client, right))
    assert c["state"] == "ok" and abs(c["shift_s"]) <= 1 and c["stuck"] == 0


def test_stuck_gps_time_is_reported(stuck):
    with TestClient(main.app) as client:
        c = clock_of(client, open_project(client, stuck))
    assert c["state"] == "variable" and c["stuck"] > 0


def test_fix_refused_when_clock_is_right(right, tmp_path):
    with TestClient(main.app) as client:
        pid = open_project(client, right)
        client.post(f"/api/projects/{pid}/sequences/bulk", json={"segments": [[0, 30]]})
        client.post(f"/api/projects/{pid}/export", json={"out_dir": str(tmp_path / "o"), "fix_clock": True})
        job = wait_jobs(client, pid)[0]
    assert job["state"] == "error" and "horloge" in job["message"].lower()


def tags(path):
    return writer.read_tags([str(path)])[str(path)]


def test_export_corrects_time_and_restores(shifted, tmp_path):
    with TestClient(main.app) as client:
        pid = open_project(client, shifted)
        client.post(f"/api/projects/{pid}/sequences/bulk", json={"segments": [[0, 30]]})
        before = {m.path: m for m in reader.read_batch(sorted(str(p) for p in shifted.rglob("GSAC*.JPG")))}
        r = client.post(f"/api/projects/{pid}/export", json={"out_dir": str(tmp_path / "o"), "fix_clock": True})
        assert r.status_code == 202
        job = wait_jobs(client, pid)[0]
        assert job["state"] == "done", job
        out = sorted((tmp_path / "o").rglob("*.JPG"))
        assert out
        for f in out[:5]:
            m = reader.read_batch([str(f)])[0]
            assert m.gps_ts is not None
            # corrected capture time = local time (UTC + zone) within the 1 s rounding of the GPS clock
            assert abs((m.ts - m.gps_ts) - PARIS_SUMMER) <= 1.0
            assert tags(f)["OffsetTimeOriginal"] == "+02:00"
        # the sources were not touched
        assert all(reader.read_batch([p])[0].ts == m.ts for p, m in before.items())

        # in place: the source files are modified, then restored exactly
        client.post(f"/api/projects/{pid}/export", json={"fix_clock": True, "mode": "in_place"})
        assert wait_jobs(client, pid)[0]["state"] == "done"
        with db.open_project(pid) as conn:
            path = conn.execute("SELECT path FROM photo WHERE sequence_id IS NOT NULL ORDER BY idx LIMIT 1").fetchone()[0]
        assert abs(before[path].ts - reader.read_batch([path])[0].ts - SHIFT) <= 1.0
        client.post(f"/api/projects/{pid}/sources/restore")
        assert wait_jobs(client, pid)[0]["state"] == "done"
        assert reader.read_batch([path])[0].ts == before[path].ts
        assert "OffsetTimeOriginal" not in tags(path)
