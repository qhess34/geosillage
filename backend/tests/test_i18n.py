"""Server messages follow Accept-Language (French by default)."""

import time

from fastapi.testclient import TestClient

from app import i18n, jobs, main

EN = {"Accept-Language": "en-GB,en;q=0.9"}


def test_error_and_job_message_follow_language():
    with TestClient(main.app) as c:
        pid = c.post("/api/projects", json={"name": "p"}).json()["id"]
        # an error: French by default, English on request
        assert c.get(f"/api/projects/{pid}/photos/999").json()["detail"] == "Photo introuvable"
        assert c.get(f"/api/projects/{pid}/photos/999", headers=EN).json()["detail"] == "Photo not found"

        # a job message (stored in French, translated when read)
        def task(ctx):
            ctx.progress(1, 2, "Préparation de l'export…", force=True)
            for _ in range(100):
                ctx.check()
                time.sleep(0.05)

        jid = jobs.start(pid, "t", task)
        time.sleep(0.3)
        assert c.get(f"/api/projects/{pid}/jobs").json()[0]["message"] == "Préparation de l'export…"
        assert c.get(f"/api/projects/{pid}/jobs", headers=EN).json()[0]["message"] == "Preparing the export…"
        jobs.cancel(jid)
        time.sleep(0.3)
        assert c.get(f"/api/projects/{pid}/jobs").json()[0]["message"] == "Annulé"
        assert c.get(f"/api/projects/{pid}/jobs", headers=EN).json()[0]["message"] == "Cancelled"


def test_tr_templates_and_default():
    i18n.set_lang("en")
    assert i18n.tr("Export de « A »") == 'Exporting "A"'
    assert i18n.tr("Texte inconnu : x") == "Texte inconnu : x"
    i18n.set_lang(None)
    assert i18n.tr("Annulé") == "Annulé"
