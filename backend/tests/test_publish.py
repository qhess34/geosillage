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
