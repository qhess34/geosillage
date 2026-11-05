"""Points to check before publishing: reported, never acted on."""

from app import db

from .test_positions_sources import project, rows  # noqa: F401  (fixture)


def _set(pid, sql, params):
    with db.open_project(pid) as conn:
        conn.executemany(sql, params)


def _clean(pid):
    """Neutral starting point: no DOP, no manual heading (the samples carry real values)."""
    _set(pid, "UPDATE photo SET gps_dop=NULL, heading_manual=NULL WHERE id=?", [(r["id"],) for r in rows_of(pid)])


def rows_of(pid):
    with db.open_project(pid) as conn:
        return [dict(r) for r in conn.execute("SELECT id, idx, lat_orig, lon_orig, flags FROM photo WHERE excluded=0 ORDER BY idx")]


def test_stop_spacing_dop_and_heading_reported(project):  # noqa: F811
    client, pid, _, seqs = project
    _clean(pid)
    base = client.get(f"/api/projects/{pid}/quality").json()
    ps = [r for r in rows_of(pid) if not r["flags"] & (db.GPS_JUMP | db.GAP_BEFORE | db.NO_GPS | db.INVALID_COORD)]
    a, b = ps[20], ps[21]
    # a stop: 4 photos at the position of the first one
    stop = [p for p in ps if 30 <= p["idx"] <= 33]
    assert len(stop) == 4
    _set(pid, "UPDATE photo SET lat=?, lon=?, pos_method='manual' WHERE id=?", [(stop[0]["lat_orig"], stop[0]["lon_orig"] + 1e-6 * i, p["id"]) for i, p in enumerate(stop)])
    # imprecise GPS on two consecutive photos, a manual heading opposite to the computed one
    _set(pid, "UPDATE photo SET gps_dop=? WHERE id=?", [(8.5, a["id"]), (6.0, b["id"])])
    with db.open_project(pid) as conn:
        auto = conn.execute("SELECT heading_auto FROM photo WHERE id=?", (ps[40]["id"],)).fetchone()[0]
    _set(pid, "UPDATE photo SET heading_manual=? WHERE id=?", [((auto + 170) % 360, ps[40]["id"])])

    got = client.get(f"/api/projects/{pid}/quality").json()
    new = [i for i in got if i not in base]
    kinds = {i["kind"]: i for i in new}
    assert kinds["stop"]["start_idx"] == 30 and kinds["stop"]["end_idx"] == 33 and kinds["stop"]["count"] == 4
    assert kinds["gps_dop"]["count"] == 2 and "8.5" in kinds["gps_dop"]["detail"]
    assert kinds["heading"]["start_idx"] == ps[40]["idx"] and "170°" in kinds["heading"]["detail"]
    # moving a photo far away from its neighbours: long spacing reported
    far = ps[60]
    _set(pid, "UPDATE photo SET lat=?, lon=?, pos_method='manual' WHERE id=?", [(far["lat_orig"] + 0.0005, far["lon_orig"], far["id"])])
    sp = [i for i in client.get(f"/api/projects/{pid}/quality").json() if i["kind"] == "spacing" and i not in base]
    around = [i for i in sp if far["idx"] in (i["start_idx"], i["end_idx"])]
    assert len(around) == 2 and all(i["meters"] > 25 for i in around)  # from the previous one, to the next one
    # nothing was changed: no photo excluded, the stop is only reported
    assert all(not r["excluded"] for r in rows(client, pid) if 30 <= r["idx"] <= 33)


def test_excluded_photos_are_ignored(project):  # noqa: F811
    client, pid, _, _ = project
    _clean(pid)
    ps = [r for r in rows_of(pid) if not r["flags"]]
    _set(pid, "UPDATE photo SET gps_dop=9 WHERE id=?", [(ps[10]["id"],)])
    assert any(i["kind"] == "gps_dop" for i in client.get(f"/api/projects/{pid}/quality").json())
    client.post(f"/api/projects/{pid}/photos/exclude", json={"photo_ids": [ps[10]["id"]], "excluded": True})
    assert not any(i["kind"] == "gps_dop" for i in client.get(f"/api/projects/{pid}/quality").json())


def test_hole_left_by_excluded_photos_is_not_a_spacing(project):  # noqa: F811
    client, pid, _, _ = project
    _clean(pid)
    ps = [r for r in rows_of(pid) if not r["flags"]]
    ids = [p["id"] for p in ps[100:130]]  # about 30 photos: far more than 25 m
    client.post(f"/api/projects/{pid}/photos/exclude", json={"photo_ids": ids, "excluded": True})
    sp = [i for i in client.get(f"/api/projects/{pid}/quality").json() if i["kind"] == "spacing"]
    assert not any(i["start_idx"] < ps[115]["idx"] < i["end_idx"] for i in sp)
