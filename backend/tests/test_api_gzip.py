from fastapi.testclient import TestClient

from app import main

from .test_import import wait_jobs


def test_photos_json_is_gzipped_when_accepted(samples):
    with TestClient(main.app) as client:
        pid = client.post("/api/projects", json={"name": "gzip"}).json()["id"]
        client.post(f"/api/projects/{pid}/import", json={"paths": [str(samples)]})
        wait_jobs(client, pid)
        r = client.get(f"/api/projects/{pid}/photos", headers={"Accept-Encoding": "gzip"})
        assert r.status_code == 200
        assert r.headers["content-encoding"] == "gzip"
        assert r.json()  # decoded body is valid JSON
        plain = client.get(f"/api/projects/{pid}/photos", headers={"Accept-Encoding": "identity"})
        assert "content-encoding" not in plain.headers
        assert plain.json() == r.json()
        assert len(plain.content) > 1000  # above the GZip threshold
