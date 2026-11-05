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


# ---- Already published sequences: link, compare, send corrections, put back ----

import re  # noqa: E402

from .core import geo, headings  # noqa: E402
from .exif import writer  # noqa: E402

UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
POS_TOLERANCE_M = 0.5
YAW_TOLERANCE = 0.5
NUDGE = writer.NUDGE  # pitch / roll written with a yaw, for the viewer to apply it


def _items(c: httpx.Client, collection_id: str) -> list[dict]:
    """All pictures of a published sequence (paginated)."""
    out, url = [], f"/api/collections/{collection_id}/items?limit=500"
    while url:
        r = c.get(url)
        if r.status_code == 404:
            raise PanoramaxError("Séquence introuvable sur l'instance (identifiant, ou séquence d'un autre compte ?)")
        if r.status_code >= 400:
            raise _error(r, "Lecture de la séquence publiée")
        j = r.json()
        out += j.get("features", [])
        url = next((l["href"] for l in j.get("links", []) if l.get("rel") == "next"), None)
    return out


def _publication(conn, sid: int, inst: str):
    return conn.execute(
        "SELECT * FROM publication WHERE sequence_id=? AND instance=? ORDER BY id DESC LIMIT 1", (sid, inst)
    ).fetchone()


def _collection_id(c: httpx.Client, conn, pub) -> str:
    if pub["collection_id"]:
        return pub["collection_id"]
    r = c.get(f"/api/upload_sets/{pub['upload_set_id']}")
    colls = r.json().get("associated_collections", []) if r.status_code == 200 else []
    if len(colls) != 1:
        raise PanoramaxError("Séquence publiée pas encore prête sur l'instance : réessayez plus tard")
    conn.execute("UPDATE publication SET collection_id=? WHERE id=?", (colls[0]["id"], pub["id"]))
    return colls[0]["id"]


def link(pid: str, sid: int, collection: str) -> dict:
    """Links a sequence published outside the application to the local one: pictures matched by original file
    name (exported or source name), otherwise by capture time (± 1.5 s)."""
    m = UUID_RE.search(collection or "")
    if not m:
        raise PanoramaxError("Identifiant de séquence Panoramax introuvable dans le texte (collez l'adresse ou l'identifiant)")
    cid = m.group(0).lower()
    inst, token = _account()
    with client(inst, token) as c:
        feats = _items(c, cid)
    if not feats:
        raise PanoramaxError("La séquence publiée ne contient aucune photo")
    with db.open_project(pid) as conn:
        photos = conn.execute(
            "SELECT id, filename, path, moved_from, ts, gps_ts FROM photo WHERE sequence_id=? ORDER BY idx", (sid,)
        ).fetchall()
        rep = conn.execute("SELECT report FROM export WHERE sequence_id=? ORDER BY id DESC LIMIT 1", (sid,)).fetchone()
        exported = {it["photo_id"]: os.path.basename(it["file"]) for it in (json.loads(rep[0]).get("items", []) if rep else [])}
        by_name = {}
        for p in photos:
            for n in {p["filename"], os.path.basename(p["moved_from"] or p["path"]), exported.get(p["id"])}:
                if n:
                    by_name.setdefault(n.lower(), p["id"])
        matched: dict[int, tuple[str, str]] = {}
        unmatched = []
        for f in feats:
            name = (f["properties"].get("original_file:name") or "").lower()
            pid_ = by_name.get(name)
            if pid_ is not None and pid_ not in matched:
                matched[pid_] = (f["id"], f["properties"].get("original_file:name") or "")
            else:
                unmatched.append(f)
        if unmatched:
            from datetime import datetime

            free = [p for p in photos if p["id"] not in matched]
            for f in unmatched:
                try:
                    t = datetime.fromisoformat(f["properties"]["datetime"].replace("Z", "+00:00")).timestamp()
                except (KeyError, ValueError):
                    continue
                best = min(free, key=lambda p: min(abs((p["gps_ts"] or 1e18) - t), abs((p["ts"] or 1e18) - t)), default=None)
                if best and min(abs((best["gps_ts"] or 1e18) - t), abs((best["ts"] or 1e18) - t)) <= 1.5:
                    matched[best["id"]] = (f["id"], f["properties"].get("original_file:name") or "")
                    free.remove(best)
        if not matched:
            raise PanoramaxError("Aucune photo de la séquence publiée ne correspond à cette séquence (noms de fichiers, heures)")
        conn.execute("DELETE FROM published_photo WHERE sequence_id=? AND instance=?", (sid, inst))
        now = time.time()
        conn.executemany(
            "INSERT OR REPLACE INTO published_photo(photo_id, instance, sequence_id, upload_set_id, picture_id, file_name, sent_at) VALUES(?, ?, ?, '', ?, ?, ?)",
            [(p, inst, sid, pic, name, now) for p, (pic, name) in matched.items()],
        )
        conn.execute(
            "INSERT INTO publication(sequence_id, instance, upload_set_id, collection_id, ts, photo_count, state, message) VALUES(?, ?, '', ?, ?, ?, 'ready', ?)",
            (sid, inst, cid, now, len(feats), "associée à une séquence déjà publiée"),
        )
    return {"collection_id": cid, "matched": len(matched), "local": len(photos), "remote": len(feats)}


def _expected(conn, sid: int) -> dict[int, dict]:
    """What the export writes for each photo of the sequence: position, heading (rounded like Panoramax), yaw."""
    rows = conn.execute(
        f"""SELECT p.id, COALESCE(p.lat, p.lat_orig) lat, COALESCE(p.lon, p.lon_orig) lon, p.yaw_offset,
                   {headings.FINAL_SQL} AS heading
            FROM photo p JOIN sequence s ON s.id = p.sequence_id WHERE p.sequence_id=?""",
        (sid,),
    ).fetchall()
    out = {}
    for r in rows:
        h = r["heading"]
        out[r["id"]] = {
            "lat": r["lat"],
            "lon": r["lon"],
            "heading": None if h is None else int(round(writer.heading_value(h, True))) % 360 or 360,
            "yaw": round(r["yaw_offset"] % 360.0, 2) if r["yaw_offset"] is not None else 0.0,
        }
    return out


def _server_values(f: dict) -> dict:
    p = f["properties"]
    lon, lat = ((f.get("geometry") or {}).get("coordinates") or [None, None])[:2]
    return {
        "lat": lat,
        "lon": lon,
        "heading": p.get("view:azimuth"),
        "yaw": float(p.get("pers:yaw") or 0.0) % 360.0,
        "pitch": float(p.get("pers:pitch") or 0.0),
        "roll": float(p.get("pers:roll") or 0.0),
    }


def _changes(exp: dict, srv: dict) -> dict:
    """PATCH body bringing the server values to the expected ones ({} = nothing to send)."""
    body = {}
    if exp["lat"] is not None and (srv["lat"] is None or geo.distance(exp["lat"], exp["lon"], srv["lat"], srv["lon"]) > POS_TOLERANCE_M):
        body.update(latitude=exp["lat"], longitude=exp["lon"])
    if exp["heading"] is not None and (srv["heading"] is None or abs((exp["heading"] - srv["heading"] + 180) % 360 - 180) >= 1):
        body["heading"] = exp["heading"]
    if abs((exp["yaw"] - srv["yaw"] + 180) % 360 - 180) > YAW_TOLERANCE:
        body["yaw"] = exp["yaw"]
    if exp["yaw"] and (abs(srv["pitch"]) < NUDGE / 2 or abs(srv["roll"]) < NUDGE / 2):
        # the viewer applies a yaw only when pitch and roll are both non-zero
        body.update(pitch=srv["pitch"] or NUDGE, roll=srv["roll"] or NUDGE)
    return body


def compare(pid: str, sid: int) -> dict:
    inst, token = _account()
    with db.open_project(pid) as conn, client(inst, token) as c:
        pub = _publication(conn, sid, inst)
        if not pub:
            raise PanoramaxError("Séquence ni publiée ni associée sur cette instance")
        cid = _collection_id(c, conn, pub)
        feats = {f["id"]: f for f in _items(c, cid)}
        links = {r["photo_id"]: r["picture_id"] for r in conn.execute(
            "SELECT photo_id, picture_id FROM published_photo WHERE sequence_id=? AND instance=? AND picture_id IS NOT NULL", (sid, inst))}
        exp = _expected(conn, sid)
        excluded = {r[0] for r in conn.execute(
            f"SELECT id FROM photo WHERE id IN ({','.join('?' * len(links)) or 'NULL'}) AND (excluded = 1 OR sequence_id IS NOT ?)", (*links, sid))}
        edit = conn.execute("SELECT id, ts FROM published_edit WHERE sequence_id=? AND instance=? AND reverted=0 ORDER BY id DESC LIMIT 1", (sid, inst)).fetchone()
    patches, deletes = [], []
    counts = {"positions": 0, "headings": 0, "orientations": 0}
    for photo_id, pic in links.items():
        f = feats.get(pic)
        if f is None:
            continue  # deleted on the instance
        if photo_id in excluded:
            deletes.append(pic)
            continue
        if photo_id not in exp:
            continue
        body = _changes(exp[photo_id], _server_values(f))
        if body:
            patches.append({"photo_id": photo_id, "picture_id": pic, "body": body, "before": _server_values(f)})
            counts["positions"] += "latitude" in body
            counts["headings"] += "heading" in body
            counts["orientations"] += "yaw" in body or "pitch" in body
    not_published = len([p for p in exp if p not in links])
    return {
        "instance": inst,
        "collection_id": cid,
        **counts,
        "photos_to_update": len(patches),
        "to_delete": len(deletes),
        "not_published": not_published,  # photos added since: cannot be added, republish
        "last_edit": {"id": edit["id"], "ts": edit["ts"]} if edit else None,
        "_patches": patches,
        "_deletes": deletes,
    }


def push(ctx, pid: str, sid: int, delete_excluded: bool) -> None:
    """Sends the differences (PATCH per picture), and deletes the excluded pictures if asked."""
    inst, token = _account()
    d = compare(pid, sid)
    patches, deletes = d["_patches"], (d["_deletes"] if delete_excluded else [])
    total = len(patches) + len(deletes)
    done, sent, errors, removed = 0, [], [], []
    lock = threading.Lock()
    with client(inst, token) as c:
        def one_patch(p):
            nonlocal done
            ctx.check()
            r = c.patch(f"/api/collections/{d['collection_id']}/items/{p['picture_id']}", json=p["body"])
            with lock:
                done += 1
                ctx.progress(done, total, "Envoi des corrections sur Panoramax")
                if r.status_code < 300:
                    before = {k: p["before"][k] for k in ("lat", "lon", "heading", "yaw", "pitch", "roll")}
                    sent.append({"picture_id": p["picture_id"], "before": before, "after": p["body"]})
                else:
                    errors.append(str(_error(r, "correction")))

        with ThreadPoolExecutor(PARALLEL_UPLOADS) as pool:
            list(pool.map(one_patch, patches))
        for pic in deletes:
            r = c.delete(f"/api/collections/{d['collection_id']}/items/{pic}")
            done += 1
            ctx.progress(done, total, "Suppression des photos exclues sur Panoramax")
            if r.status_code < 300 or r.status_code == 404:
                removed.append(pic)
            else:
                errors.append(str(_error(r, "suppression")))
    with db.open_project(pid) as conn:
        if sent or removed:
            conn.execute(
                "INSERT INTO published_edit(sequence_id, instance, collection_id, ts, data, deleted) VALUES(?, ?, ?, ?, ?, ?)",
                (sid, inst, d["collection_id"], time.time(), json.dumps(sent), json.dumps(removed)),
            )
        if removed:
            conn.execute(
                f"DELETE FROM published_photo WHERE instance=? AND picture_id IN ({','.join('?' * len(removed))})", (inst, *removed)
            )
        if not errors:
            # the publication is up to date again: "changed since the publication" is cleared
            conn.execute(
                "UPDATE publication SET ts=? WHERE id=(SELECT MAX(id) FROM publication WHERE sequence_id=? AND instance=?)",
                (time.time(), sid, inst),
            )
    ctx.progress(total, total, f"{len(sent)} photo(s) corrigée(s), {len(removed)} supprimée(s) sur Panoramax", force=True)
    if errors:
        raise PanoramaxError(f"{len(errors)} correction(s) refusée(s) : {errors[0]}")


def revert(ctx, pid: str, sid: int) -> None:
    """Puts back the server values from before the last corrections sent (deleted pictures cannot come back)."""
    inst, token = _account()
    with db.open_project(pid) as conn:
        e = conn.execute(
            "SELECT * FROM published_edit WHERE sequence_id=? AND instance=? AND reverted=0 ORDER BY id DESC LIMIT 1", (sid, inst)
        ).fetchone()
    if not e:
        raise PanoramaxError("Aucune correction envoyée à remettre")
    data = json.loads(e["data"])
    errors = []
    with client(inst, token) as c:
        for n, it in enumerate(data, 1):
            b = it["before"]
            body = {}
            if "latitude" in it["after"]:
                body.update(latitude=b["lat"], longitude=b["lon"])
            if "heading" in it["after"] and b["heading"] is not None:
                body["heading"] = b["heading"]
            if "yaw" in it["after"]:
                body["yaw"] = b["yaw"]
            if "pitch" in it["after"]:
                body.update(pitch=b["pitch"], roll=b["roll"])
            if body:
                r = c.patch(f"/api/collections/{e['collection_id']}/items/{it['picture_id']}", json=body)
                if r.status_code >= 300:
                    errors.append(str(_error(r, "retour en arrière")))
            ctx.progress(n, len(data), "Valeurs d'avant remises sur Panoramax")
    with db.open_project(pid) as conn:
        conn.execute("UPDATE published_edit SET reverted=1 WHERE id=?", (e["id"],))
    if errors:
        raise PanoramaxError(f"{len(errors)} photo(s) non remise(s) : {errors[0]}")
