"""Publication on a Panoramax instance.

Connection: the application asks the instance for a token (`POST /api/auth/tokens/generate`); the user opens the
claim link and logs in on the instance; the token is then usable (`GET /api/users/me` answers). Tokens are kept in
`<DATA_DIR>/panoramax.json` (mode 600) and never sent to the interface.

Publication of a sequence = one upload set (`no_split`, `no_deduplication`, sorted by time, never
`relative_heading`) with the files of the sequence's last export, then `complete`, then waiting for the server to
dispatch and process the pictures. See doc/ETUDE_PHASE1.md § 2.
"""

import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

from . import config, db, exporter, jobs

USER_AGENT = "PanoramaxSequenceStudio/1.0 (+https://github.com/qhess34/panoramax-preprocess)"
DEFAULT_INSTANCE = "https://panoramax.openstreetmap.fr"
PARALLEL_UPLOADS = 3
WAIT_READY_S = 30 * 60
TRANSPORT = None  # httpx transport, replaced in tests by a fake server
_lock = threading.Lock()


class PanoramaxError(jobs.UserError):
    pass


# ---- Settings and tokens (never returned to the interface) ----


def _store_path() -> Path:
    return config.DATA_DIR / "panoramax.json"


def _load() -> dict:
    try:
        return json.loads(_store_path().read_text())
    except (FileNotFoundError, ValueError):
        return {"instance": DEFAULT_INSTANCE, "accounts": {}}


def _save(data: dict) -> None:
    p = _store_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f)
    os.replace(tmp, p)
    os.chmod(p, 0o600)


def normalize_instance(url: str) -> str:
    url = url.strip().rstrip("/")
    if url.endswith("/api"):
        url = url[:-4]
    if not url.startswith(("https://", "http://")):
        raise PanoramaxError("Adresse d'instance invalide (https://…)")
    return url


def status() -> dict:
    data = _load()
    inst = data.get("instance") or DEFAULT_INSTANCE
    acc = data.get("accounts", {}).get(inst) or {}
    return {
        "instance": inst,
        "connected": bool(acc.get("claimed")),
        "account": acc.get("name"),
        "claim_url": acc.get("claim_url") if acc.get("token") and not acc.get("claimed") else None,
    }


def set_instance(url: str) -> dict:
    with _lock:
        data = _load()
        data["instance"] = normalize_instance(url)
        _save(data)
    return status()


def client(instance: str, token: str | None = None) -> httpx.Client:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return httpx.Client(base_url=instance, headers=headers, timeout=httpx.Timeout(120, connect=20), transport=TRANSPORT)


def _error(r: httpx.Response, what: str) -> PanoramaxError:
    try:
        msg = r.json().get("message") or r.text[:200]
    except ValueError:
        msg = r.text[:200]
    return PanoramaxError(f"{what} : erreur {r.status_code} de l'instance ({msg})")


def login() -> dict:
    """Asks the instance for a new token; the user must open the claim link."""
    with _lock:
        data = _load()
        inst = data.get("instance") or DEFAULT_INSTANCE
        try:
            with client(inst) as c:
                r = c.post("/api/auth/tokens/generate", params={"description": "Panoramax Sequence Studio"})
        except httpx.HTTPError as e:
            raise PanoramaxError(f"Instance injoignable ({inst}) : {e}")
        if r.status_code >= 400:
            raise _error(r, "Création du jeton")
        j = r.json()
        claim = next((l["href"] for l in j.get("links", []) if l.get("rel") == "claim"), None)
        if not j.get("jwt_token") or not claim:
            raise PanoramaxError("Réponse inattendue de l'instance (jeton ou lien de validation manquant)")
        data.setdefault("accounts", {})[inst] = {"token": j["jwt_token"], "token_id": j.get("id"), "claim_url": claim, "claimed": False}
        _save(data)
    return status()


def check() -> dict:
    """Is the token claimed (the user logged in through the claim link)?"""
    with _lock:
        data = _load()
        inst = data.get("instance") or DEFAULT_INSTANCE
        acc = data.get("accounts", {}).get(inst)
        if not acc or not acc.get("token"):
            raise PanoramaxError("Pas de connexion en cours : « Se connecter » d'abord")
        try:
            with client(inst, acc["token"]) as c:
                r = c.get("/api/users/me")
        except httpx.HTTPError as e:
            raise PanoramaxError(f"Instance injoignable ({inst}) : {e}")
        if r.status_code == 200:
            acc.update(claimed=True, name=r.json().get("name"), claim_url=None)
            _save(data)
        elif r.status_code not in (401, 403):
            raise _error(r, "Vérification du compte")
    return status()


def logout() -> dict:
    with _lock:
        data = _load()
        data.get("accounts", {}).pop(data.get("instance") or DEFAULT_INSTANCE, None)
        _save(data)
    return status()


def _account() -> tuple[str, str]:
    data = _load()
    inst = data.get("instance") or DEFAULT_INSTANCE
    acc = data.get("accounts", {}).get(inst) or {}
    if not acc.get("claimed"):
        raise PanoramaxError("Non connecté à Panoramax : onglet Export, « Se connecter »")
    return inst, acc["token"]


# ---- Publication ----


def last_publications(conn) -> dict[int, dict]:
    """Latest publication of each sequence (any instance)."""
    out = {}
    for r in conn.execute("SELECT * FROM publication p WHERE id = (SELECT MAX(id) FROM publication WHERE sequence_id = p.sequence_id)"):
        first = conn.execute(
            """SELECT pp.picture_id FROM published_photo pp JOIN photo p ON p.id = pp.photo_id
                WHERE pp.sequence_id=? AND pp.instance=? AND pp.picture_id IS NOT NULL ORDER BY p.idx LIMIT 1""",
            (r["sequence_id"], r["instance"]),
        ).fetchone()
        out[r["sequence_id"]] = {
            **{k: r[k] for k in ("instance", "upload_set_id", "collection_id", "ts", "photo_count", "state", "message")},
            "first_picture_id": first[0] if first else None,
        }
    return out


def _export_items(pid: str, ctx, sid: int) -> tuple[str, list[dict]]:
    """Files of the sequence's last export (exported again first if the sequence changed since)."""
    from .core import sequences as core_seq

    with db.open_project(pid) as conn:
        name = conn.execute("SELECT name FROM sequence WHERE id=?", (sid,)).fetchone()
        if not name:
            raise PanoramaxError(f"Séquence {sid} introuvable")
        name = name[0]
        last = exporter.last_exports(conn).get(sid)
        stats = next((s for s in core_seq.list_with_stats(conn) if s["id"] == sid), None)
    if not last:
        raise PanoramaxError(f"« {name} » n'a jamais été exportée : exportez-la d'abord (onglet Export)")
    with db.open_project(pid) as conn:
        rep = json.loads(conn.execute("SELECT report FROM export WHERE sequence_id=? ORDER BY id DESC LIMIT 1", (sid,)).fetchone()[0])
    if (stats and stats["needs_export"]) or "items" not in rep:
        ctx.progress(0, None, f"Réexport de « {name} » avant publication", force=True)
        exporter.run(ctx, last["out_dir"], [sid], last["panoramax_compat"], last["exclude_gps_jumps"], last["mode"])
        with db.open_project(pid) as conn:
            rep = json.loads(conn.execute("SELECT report FROM export WHERE sequence_id=? ORDER BY id DESC LIMIT 1", (sid,)).fetchone()[0])
        if rep.get("problems"):
            raise PanoramaxError(f"Le réexport de « {name} » a signalé des problèmes : publication annulée")
    items = rep.get("items") or []
    missing = [it["file"] for it in items if not os.path.isfile(it["file"])]
    if not items:
        raise PanoramaxError(f"« {name} » : aucune photo exportée")
    if missing:
        raise PanoramaxError(f"« {name} » : {len(missing)} fichier(s) exporté(s) introuvable(s), réexportez la séquence")
    return name, items


def _ready(us: dict) -> bool:
    if not us.get("dispatched"):
        return False
    for c in us.get("associated_collections", []):
        st = c.get("items_status") or {}
        if (st.get("preparing") or 0) > 0 or (st.get("not_processed") or 0) > 0:
            return False
    return True


def publish(ctx, pid: str, sequence_ids: list[int], visibility: str = "anyone", bike: bool = True) -> None:
    inst, token = _account()
    for n, sid in enumerate(sequence_ids, 1):
        ctx.check()
        name, items = _export_items(pid, ctx, sid)
        with client(inst, token) as c:
            _publish_one(ctx, pid, c, inst, sid, name, items, visibility, bike, f"({n}/{len(sequence_ids)}) ")


def _publish_one(ctx, pid, c: httpx.Client, inst, sid, name, items, visibility, bike, prefix) -> None:
    # Resume an interrupted publication of the same sequence on the same instance
    with db.open_project(pid) as conn:
        prev = conn.execute(
            "SELECT * FROM publication WHERE sequence_id=? AND instance=? AND state='uploading' ORDER BY id DESC LIMIT 1", (sid, inst)
        ).fetchone()
    sent: dict[str, str | None] = {}
    if prev:
        us_id, pub_id = prev["upload_set_id"], prev["id"]
        r = c.get(f"/api/upload_sets/{us_id}/files")
        if r.status_code == 200:
            sent = {f["file_name"]: f.get("picture_id") for f in r.json().get("files", [])}
        else:
            prev = None
    if not prev:
        body = {
            "title": name,
            "estimated_nb_files": len(items),
            "sort_method": "time-asc",
            "no_split": True,
            "no_deduplication": True,
            "visibility": visibility,
        }
        if bike:
            body["semantics"] = [{"key": "transport", "value": "bike"}]
        r = c.post("/api/upload_sets", json=body)
        if r.status_code >= 400:
            raise _error(r, f"Création de l'envoi de « {name} »")
        us_id = r.json()["id"]
        with db.open_project(pid) as conn:
            pub_id = conn.execute(
                "INSERT INTO publication(sequence_id, instance, upload_set_id, ts, photo_count, state) VALUES(?, ?, ?, ?, ?, 'uploading')",
                (sid, inst, us_id, time.time(), len(items)),
            ).lastrowid

    todo = [it for it in items if os.path.basename(it["file"]) not in sent]
    done = len(items) - len(todo)
    errors: list[str] = []
    lock = threading.Lock()

    def record(it, picture_id):
        with db.open_project(pid) as conn:
            conn.execute(
                "INSERT OR REPLACE INTO published_photo(photo_id, instance, sequence_id, upload_set_id, picture_id, file_name, sent_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
                (it["photo_id"], inst, sid, us_id, picture_id, os.path.basename(it["file"]), time.time()),
            )

    for it in items:
        if os.path.basename(it["file"]) in sent:
            record(it, sent[os.path.basename(it["file"])])

    def send(it):
        nonlocal done
        ctx.check()
        fn = os.path.basename(it["file"])
        for attempt in range(3):
            try:
                with open(it["file"], "rb") as fh:
                    r = c.post(f"/api/upload_sets/{us_id}/files", files={"file": (fn, fh, "image/jpeg")})
                break
            except httpx.HTTPError as e:
                if attempt == 2:
                    with lock:
                        errors.append(f"{fn} : {e}")
                    return
                time.sleep(2 * (attempt + 1))
        if r.status_code in (200, 201, 202):
            record(it, r.json().get("picture_id"))
        elif r.status_code == 409 and (r.json().get("existing_item") or {}).get("id"):
            record(it, r.json()["existing_item"]["id"])  # already in this upload set (resumed upload)
        else:
            with lock:
                errors.append(f"{fn} : {_error(r, 'envoi')}")
            return
        with lock:
            done += 1
            ctx.progress(done, len(items), f"{prefix}Envoi de « {name} » sur Panoramax")

    with ThreadPoolExecutor(PARALLEL_UPLOADS) as pool:
        list(pool.map(send, todo))
    if errors:
        with db.open_project(pid) as conn:
            conn.execute("UPDATE publication SET message=? WHERE id=?", (f"{len(errors)} fichier(s) non envoyé(s) ; relancez la publication", pub_id))
        raise PanoramaxError(f"« {name} » : {len(errors)} fichier(s) non envoyé(s) (relancez : l'envoi reprendra) — {errors[0]}")

    r = c.post(f"/api/upload_sets/{us_id}/complete")
    if r.status_code >= 400 and r.status_code != 409:
        raise _error(r, f"Finalisation de « {name} »")
    with db.open_project(pid) as conn:
        conn.execute("UPDATE publication SET state='processing' WHERE id=?", (pub_id,))

    # Wait for the server: dispatch (one collection, thanks to no_split) and processing of the pictures
    deadline = time.time() + WAIT_READY_S
    us = {}
    while time.time() < deadline:
        ctx.check()
        r = c.get(f"/api/upload_sets/{us_id}")
        if r.status_code == 200:
            us = r.json()
            if _ready(us):
                break
        ctx.progress(len(items), len(items), f"{prefix}« {name} » : traitement par Panoramax (floutage…)", force=True)
        time.sleep(5 if TRANSPORT is None else 0)
    colls = us.get("associated_collections", [])
    state, msg = "ready", None
    if not _ready(us):
        state, msg = "processing", "Envoyée ; traitement toujours en cours sur l'instance"
    elif len(colls) != 1:
        state, msg = "error", f"L'instance a créé {len(colls)} séquences au lieu d'une"
    elif colls[0].get("nb_items") not in (None, len(items)):
        state, msg = "error", f"{colls[0].get('nb_items')} photo(s) publiée(s) sur {len(items)}"
    with db.open_project(pid) as conn:
        conn.execute(
            "UPDATE publication SET state=?, message=?, collection_id=? WHERE id=?",
            (state, msg, colls[0]["id"] if colls else None, pub_id),
        )
    if state == "error":
        raise PanoramaxError(f"« {name} » : {msg}")
