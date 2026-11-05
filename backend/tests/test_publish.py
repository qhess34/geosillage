import json
import os
import stat
import uuid

import httpx
import pytest
from fastapi.testclient import TestClient

from app import config, db, main, panoramax

from .test_import import wait_jobs


class FakePanoramax:
    """In-memory Panoramax instance (the routes used by the application)."""

    def __init__(self):
        self.claimed = False
        self.upload_sets = {}
        self.files = {}  # upload set id -> {file name: picture id}
        self.fail_after = None  # simulate a network drop after N files
        self.posted = 0

    def __call__(self, req: httpx.Request) -> httpx.Response:
        p, m = req.url.path, req.method
        authed = req.headers.get("authorization") == "Bearer tok"
        if p == "/api/auth/tokens/generate" and m == "POST":
            return httpx.Response(200, json={"id": "t1", "jwt_token": "tok", "links": [{"rel": "claim", "href": "https://pnx.test/api/auth/tokens/t1/claim"}]})
        if p == "/api/users/me":
            return httpx.Response(200, json={"name": "Quentin"}) if authed and self.claimed else httpx.Response(401, json={"message": "unclaimed"})
        if not authed:
            return httpx.Response(401, json={"message": "auth"})
        if p == "/api/upload_sets" and m == "POST":
            us = str(uuid.uuid4())
            self.upload_sets[us] = {"body": json.loads(req.content), "completed": False}
            self.files[us] = {}
            return httpx.Response(200, json={"id": us})
        parts = p.split("/")
        if len(parts) >= 4 and parts[2] == "upload_sets":
            us = parts[3]
            if p.endswith("/files") and m == "POST":
                if self.fail_after is not None and self.posted >= self.fail_after:
                    return httpx.Response(503, json={"message": "unavailable"})
                self.posted += 1
                name = req.content.split(b'filename="')[1].split(b'"')[0].decode()
                if name in self.files[us]:
                    return httpx.Response(409, json={"message": "dup", "existing_item": {"id": self.files[us][name]}})
                pic = str(uuid.uuid4())
                self.files[us][name] = pic
                return httpx.Response(202, json={"picture_id": pic, "file_name": name})
            if p.endswith("/files") and m == "GET":
                return httpx.Response(200, json={"files": [{"file_name": n, "picture_id": i} for n, i in self.files[us].items()]})
            if p.endswith("/complete"):
                self.upload_sets[us]["completed"] = True
                return httpx.Response(200, json={})
            n = len(self.files[us])
            done = self.upload_sets[us]["completed"]
            return httpx.Response(200, json={"id": us, "dispatched": done, "associated_collections": [
                {"id": "col-" + us[:8], "nb_items": n, "items_status": {"prepared": n, "preparing": 0, "not_processed": 0}}] if done else []})
        return httpx.Response(404, json={"message": p})


@pytest.fixture()
def fake(monkeypatch):
    f = FakePanoramax()
    monkeypatch.setattr(panoramax, "TRANSPORT", httpx.MockTransport(f))
    return f


@pytest.fixture()
def project(samples, tmp_path):
    with TestClient(main.app) as client:
        pid = client.post("/api/projects", json={"name": "Publi"}).json()["id"]
        client.post(f"/api/projects/{pid}/import", json={"paths": [str(samples)]})
        wait_jobs(client, pid)
        props = client.get(f"/api/projects/{pid}/sequences/proposals").json()
        seqs = client.post(f"/api/projects/{pid}/sequences/bulk", json={"segments": [[p["start_idx"], p["end_idx"]] for p in props]}).json()["sequences"]
        client.post(f"/api/projects/{pid}/export", json={"out_dir": str(tmp_path / "out"), "sequence_ids": [seqs[0]["id"]]})
        wait_jobs(client, pid)
        yield client, pid, seqs


def connect(client, fake):
    client.put("/api/panoramax/instance", json={"url": "https://pnx.test/"})
    st = client.post("/api/panoramax/login").json()
    assert st["claim_url"].endswith("/claim") and not st["connected"]
    assert not client.post("/api/panoramax/check").json()["connected"]  # not claimed yet
    fake.claimed = True
    st = client.post("/api/panoramax/check").json()
    assert st == {"instance": "https://pnx.test", "connected": True, "account": "Quentin", "claim_url": None}


def test_connection_token_kept_private(project, fake):
    client, _, _ = project
    connect(client, fake)
    path = config.DATA_DIR / "panoramax.json"
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    assert "tok" not in json.dumps(client.get("/api/panoramax").json())
    assert not client.post("/api/panoramax/logout").json()["connected"]


def test_publish_requires_connection_and_export(project, fake):
    client, pid, seqs = project
    assert client.post(f"/api/projects/{pid}/publish", json={"sequence_ids": [seqs[0]["id"]]}).status_code == 409
    connect(client, fake)
    client.post(f"/api/projects/{pid}/publish", json={"sequence_ids": [seqs[1]["id"]]})  # never exported
    jobs_ = wait_jobs(client, pid)
    job = next(j for j in client.get(f"/api/projects/{pid}").json()["jobs"] if j["kind"] == "publish")
    assert job["state"] == "error" and "jamais été exportée" in job["message"]


def test_publish_one_upload_set_per_sequence(project, fake):
    client, pid, seqs = project
    connect(client, fake)
    client.post(f"/api/projects/{pid}/publish", json={"sequence_ids": [seqs[0]["id"]], "visibility": "owner-only"})
    wait_jobs(client, pid)
    job = next(j for j in client.get(f"/api/projects/{pid}").json()["jobs"] if j["kind"] == "publish")
    assert job["state"] == "done", job
    (us, info), = fake.upload_sets.items()
    b = info["body"]
    assert b["no_split"] is True and b["no_deduplication"] is True and b["sort_method"] == "time-asc"
    assert b["visibility"] == "owner-only" and b["semantics"] == [{"key": "transport", "value": "bike"}]
    assert "relative_heading" not in b and b["title"] == seqs[0]["name"]
    n = client.get(f"/api/projects/{pid}/exports").json()[0]["photo_count"]  # GPS jumps are left out by the export
    assert len(fake.files[us]) == n == b["estimated_nb_files"] and n >= seqs[0]["count"] - 2
    s = next(x for x in client.get(f"/api/projects/{pid}/sequences").json()["sequences"] if x["id"] == seqs[0]["id"])
    assert s["last_publication"]["state"] == "ready" and s["last_publication"]["collection_id"].startswith("col-")
    assert not s["changed_since_publication"]
    with db.open_project(pid) as conn:
        assert conn.execute("SELECT COUNT(*) FROM published_photo WHERE picture_id IS NOT NULL").fetchone()[0] == n
    # a later change of the sequence is reported
    client.patch(f"/api/projects/{pid}/sequences/{seqs[0]['id']}", json={"heading_offset": 3})
    s = next(x for x in client.get(f"/api/projects/{pid}/sequences").json()["sequences"] if x["id"] == seqs[0]["id"])
    assert s["changed_since_publication"]


def test_interrupted_upload_resumes_in_the_same_upload_set(project, fake):
    client, pid, seqs = project
    connect(client, fake)
    fake.fail_after = 10
    client.post(f"/api/projects/{pid}/publish", json={"sequence_ids": [seqs[0]["id"]]})
    wait_jobs(client, pid)
    job = next(j for j in client.get(f"/api/projects/{pid}").json()["jobs"] if j["kind"] == "publish")
    assert job["state"] == "error" and "relancez" in job["message"]
    fake.fail_after = None
    client.post(f"/api/projects/{pid}/publish", json={"sequence_ids": [seqs[0]["id"]]})
    wait_jobs(client, pid)
    assert len(fake.upload_sets) == 1  # same upload set, resumed
    (us,) = fake.upload_sets
    n = client.get(f"/api/projects/{pid}/exports").json()[0]["photo_count"]
    assert len(fake.files[us]) == n and fake.upload_sets[us]["completed"]


def test_changed_sequence_is_exported_again_before_publishing(project, fake):
    client, pid, seqs = project
    connect(client, fake)
    client.patch(f"/api/projects/{pid}/sequences/{seqs[0]['id']}", json={"heading_offset": 5})
    before = len(client.get(f"/api/projects/{pid}/exports").json())
    client.post(f"/api/projects/{pid}/publish", json={"sequence_ids": [seqs[0]["id"]]})
    wait_jobs(client, pid)
    assert len(client.get(f"/api/projects/{pid}/exports").json()) == before + 1
    s = next(x for x in client.get(f"/api/projects/{pid}/sequences").json()["sequences"] if x["id"] == seqs[0]["id"])
    assert not s["needs_export"] and s["last_publication"]["state"] == "ready"


# ---- Already published sequences ----


class FakeWithItems(FakePanoramax):
    """Adds the published pictures of each collection (paginated), PATCH and DELETE."""

    def __init__(self):
        super().__init__()
        self.items = {}  # collection id -> {picture id: feature}
        self.patches = []

    def __call__(self, req):
        p, m = req.url.path, req.method
        parts = p.split("/")
        if len(parts) >= 5 and parts[2] == "collections" and parts[4] == "items":
            if req.headers.get("authorization") != "Bearer tok":
                return httpx.Response(401, json={})
            col = self.items.get(parts[3])
            if col is None:
                return httpx.Response(404, json={"message": "not found"})
            if len(parts) == 5 and m == "GET":
                feats = list(col.values())
                start = int(req.url.params.get("offset", 0))
                page = feats[start : start + 20]  # small pages: pagination is followed
                links = [{"rel": "next", "href": f"/api/collections/{parts[3]}/items?limit=20&offset={start + 20}"}] if start + 20 < len(feats) else []
                return httpx.Response(200, json={"features": page, "links": links})
            pic = parts[5]
            if m == "PATCH":
                b = json.loads(req.content)
                self.patches.append((pic, b))
                f, pr = col[pic], col[pic]["properties"]
                if "latitude" in b:
                    f["geometry"]["coordinates"] = [b["longitude"], b["latitude"]]
                if "heading" in b:
                    pr["view:azimuth"] = b["heading"]
                for k in ("yaw", "pitch", "roll"):
                    if k in b:
                        pr[f"pers:{k}"] = b[k]
                return httpx.Response(200, json=f)
            if m == "DELETE":
                col.pop(pic, None)
                return httpx.Response(204)
        return super().__call__(req)

    def publish_state_from(self, cid, pid, sid):
        """Server values = what was exported (as after a correct publication)."""
        with db.open_project(pid) as conn:
            exp = panoramax._expected(conn, sid)
            links = dict(conn.execute("SELECT photo_id, picture_id FROM published_photo WHERE sequence_id=?", (sid,)).fetchall())
        self.items[cid] = {
            pic: {"id": pic, "geometry": {"type": "Point", "coordinates": [exp[ph]["lon"], exp[ph]["lat"]]},
                  "properties": {"view:azimuth": exp[ph]["heading"], "pers:yaw": exp[ph]["yaw"], "pers:pitch": 0, "pers:roll": 0,
                                 "original_file:name": f"x{ph}.jpg", "datetime": "2026-06-14T09:30:00Z"}}
            for ph, pic in links.items()
        }


@pytest.fixture()
def fake_items(monkeypatch):
    f = FakeWithItems()
    monkeypatch.setattr(panoramax, "TRANSPORT", httpx.MockTransport(f))
    return f


def published(client, pid, seqs, fake):
    connect(client, fake)
    sid = seqs[0]["id"]
    client.post(f"/api/projects/{pid}/publish", json={"sequence_ids": [sid]})
    wait_jobs(client, pid)
    s = next(x for x in client.get(f"/api/projects/{pid}/sequences").json()["sequences"] if x["id"] == sid)
    cid = s["last_publication"]["collection_id"]
    fake.publish_state_from(cid, pid, sid)
    return sid, cid


def test_compare_push_and_revert(project, fake_items):
    client, pid, seqs = project
    sid, cid = published(client, pid, seqs, fake_items)
    base = f"/api/projects/{pid}/sequences/{sid}/panoramax"
    d = client.get(f"{base}/compare").json()
    assert (d["photos_to_update"], d["to_delete"], d["not_published"]) == (0, 0, d["not_published"])
    # helmet camera badly aligned: +20° on the whole sequence; one position corrected; one photo excluded
    client.post(f"/api/projects/{pid}/headings/yaw", json={"sequence_id": sid, "add": 20})
    rows = client.get(f"/api/projects/{pid}/photos").json()
    f = rows["fields"]
    mine = [dict(zip(f, r)) for r in rows["rows"] if r[f.index("sequence_id")] == sid]
    client.put(f"/api/projects/{pid}/photos/{mine[10]['id']}/position", json={"lat": mine[10]["lat"] + 0.0001, "lon": mine[10]["lon"]})
    client.post(f"/api/projects/{pid}/photos/exclude", json={"photo_ids": [mine[20]["id"]]})
    d = client.get(f"{base}/compare").json()
    assert d["orientations"] >= len(mine) - 3 and d["positions"] >= 1 and d["to_delete"] == 1
    assert "_patches" not in d
    s = next(x for x in client.get(f"/api/projects/{pid}/sequences").json()["sequences"] if x["id"] == sid)
    assert s["changed_since_publication"]

    client.post(f"{base}/push", json={"delete_excluded": True})
    wait_jobs(client, pid)
    body = fake_items.patches[0][1]
    assert body["yaw"] == pytest.approx(20.0) and body["pitch"] == body["roll"] == pytest.approx(0.01)  # nudge for the viewer
    after = client.get(f"{base}/compare").json()
    assert (after["photos_to_update"], after["to_delete"]) == (0, 0) and after["last_edit"]
    s = next(x for x in client.get(f"/api/projects/{pid}/sequences").json()["sequences"] if x["id"] == sid)
    assert not s["changed_since_publication"]

    client.post(f"{base}/revert")
    wait_jobs(client, pid)
    back = client.get(f"{base}/compare").json()
    assert back["orientations"] == d["orientations"] and back["last_edit"] is None


def test_link_a_sequence_published_elsewhere(project, fake_items):
    client, pid, seqs = project
    connect(client, fake_items)
    sid = seqs[0]["id"]
    rows = client.get(f"/api/projects/{pid}/photos").json()
    f = rows["fields"]
    mine = [dict(zip(f, r)) for r in rows["rows"] if r[f.index("sequence_id")] == sid]
    det = [client.get(f"/api/projects/{pid}/photos/{p['id']}").json() for p in mine[:12]]
    from datetime import datetime, timezone
    feats = {}
    for i, d in enumerate(det):
        pic = str(uuid.uuid4())
        name = d["filename"] if i < 10 else "renamed.jpg"  # the last two only match by capture time
        when = datetime.fromtimestamp(d["ts"], timezone.utc).isoformat()
        feats[pic] = {"id": pic, "geometry": {"type": "Point", "coordinates": [d["lon"] or d["lon_orig"], d["lat"] or d["lat_orig"]]},
                      "properties": {"original_file:name": name, "datetime": when, "view:azimuth": 0, "pers:yaw": 0}}
    cid = str(uuid.uuid4())
    fake_items.items[cid] = feats
    r = client.post(f"/api/projects/{pid}/sequences/{sid}/panoramax/link", json={"collection": f"https://pnx.test/#focus=map&seq={cid}"}).json()
    assert r == {"collection_id": cid, "matched": 12, "local": len(mine), "remote": 12}
    d = client.get(f"/api/projects/{pid}/sequences/{sid}/panoramax/compare").json()
    assert d["collection_id"] == cid and d["not_published"] == len(mine) - 12 and d["headings"] >= 1
    bad = client.post(f"/api/projects/{pid}/sequences/{sid}/panoramax/link", json={"collection": "pas un identifiant"})
    assert bad.status_code == 409
