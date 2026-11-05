# GeoSillage (alors « Panoramax Sequence Studio ») — Phase 1 : étude technique

Sources étudiées (code source officiel, pas de supposition) :

| Dépôt (gitlab.com/panoramax) | Commit | Date |
|---|---|---|
| `server/api` (GeoVisio 2.17.0) | ad20a07 | 2026-10-27 |
| `clients/cli` (panoramax_cli) | 7197807 | 2026-09-07 |
| `server/geo-picture-tag-reader` | ad3c431 | 2026-10-23 |

`docs.panoramax.fr` n'était pas joignable depuis cet environnement : l'étude s'appuie sur le code et
l'OpenAPI embarqués dans ces dépôts (même contenu, plus précis).

---

## 1. Photos GoPro MAX

**Aucun échantillon réel disponible ici.** Ce qui est établi par le code de Panoramax :

- `cameras.csv` du tag-reader contient `"GoPro";"Max";"6.17";"1"` → la MAX est reconnue comme
  caméra **360°** par sa marque/modèle, même sans balises XMP GPano.
- Lecture de l'heure : `Exif.Photo.DateTimeOriginal` (+ `SubSecTimeOriginal`), puis repli sur
  `Exif.Image.*`, `Xmp.GPano.SourceImageCreateTime`… L'heure GPS (`GPSDateStamp`/`GPSTimeStamp`)
  est aussi lue et `TimeBySource.getBest()` choisit.
- Lecture du cap : `Exif.GPSInfo.GPSImgDirection` → sinon `MAPCompassHeading` → sinon
  `Exif.GPSInfo.GPSTrack`. **Valeur arrondie à l'entier.**
- Yaw/pitch/roll : `Xmp.Camera.*` ou `Xmp.GPano.Pose*Degrees`.

À vérifier sur échantillon réel (script d'analyse prévu, cf. §5) : présence/valeur de
`GPSImgDirection` et `GPSTrack` (souvent absent ou 0 sur MAX), `XMP-GPano:ProjectionType`,
présence de `SubSecTimeOriginal` (sinon toutes les photos d'une même seconde ont le même horodatage,
problème avec un intervalle de 2 s ±), précision de `GPSTimeStamp`, `GPSDOP`/`GPSMeasureMode`,
bloc `MakerNotes` GoPro, variations entre firmwares.

## 2. API Panoramax — ce qui compte pour l'application

### 2.1 Authentification

Pas d'OAuth exposé aux clients tiers. Le mécanisme officiel (celui de la CLI) :

1. `POST /api/auth/tokens/generate?description=…` (sans authentification) → `{id, jwt_token, links:[{rel:"claim", href}]}`.
2. L'utilisateur ouvre le lien `GET /api/auth/tokens/{id}/claim` dans son navigateur et se connecte
   (OAuth/OIDC géré par l'instance) → le jeton est associé à son compte.
3. L'application utilise ensuite `Authorization: Bearer <jwt_token>`.

Alternative : jeton créé depuis le site (`POST /api/users/me/tokens`) et collé dans l'application.
Le jeton sera stocké dans le trousseau système (`keyring` : Secret Service sous Linux), jamais en clair.

### 2.2 Upload sets — **point critique résolu**

Routes (`geovisio/web/upload_set.py`) :

| Route | Rôle |
|---|---|
| `POST /api/upload_sets` | création (`title`, `estimated_nb_files`, `sort_method`, `no_split`, `split_distance`, `split_time`, `no_deduplication`, `duplicate_distance`, `duplicate_rotation`, `metadata`, `semantics`, `relative_heading`, `visibility`) |
| `POST /api/upload_sets/{id}/files` | envoi d'un fichier (multipart : `file`, `isBlurred`, `override_capture_time`, `override_latitude`/`override_longitude`, `override_Exif.*`/`override_Xmp.*`, `picture_id`, `semantics`) |
| `GET /api/upload_sets/{id}` | état : `completed`, `dispatched`, `items_status`, `associated_collections[]` (avec `ready`) |
| `GET /api/upload_sets/{id}/files` | fichiers reçus / rejetés (`rejection_status`) → **base de la reprise** |
| `POST /api/upload_sets/{id}/complete` | finalisation explicite |
| `PATCH` / `DELETE /api/upload_sets/{id}` | modification / suppression |
| `GET /api/users/me/upload_sets` | historique |

**Dispatch** (`utils/upload_set.py: dispatch`) : à la complétion, le serveur trie
(`sort_method`), **déduplique** (distance/rotation, défauts de l'instance) puis **découpe**
(`split_distance` / `split_time`, défauts de l'instance) → **un upload_set peut produire
plusieurs collections** (`<titre>-1`, `<titre>-2`…), et des photos peuvent être supprimées comme
doublons (`rejection_status = capture_duplicate`).

➡️ **Stratégie retenue : 1 séquence de l'application = 1 upload_set** créé avec
`no_split: true`, `no_deduplication: true`, `sort_method: "time-asc"`, `title` = nom de la séquence.
Le code garantit alors une seule collection contenant toutes les photos, dans l'ordre. L'application
vérifie après dispatch que `associated_collections` a exactement 1 élément avec le bon nombre de
photos (sinon erreur affichée). C'est exactement ce que fait la CLI officielle quand elle découpe
elle-même (`no_split`/`no_deduplication` dans `panoramax_cli/upload.py`).

`POST /api/collections` existe encore mais est marqué « legacy API » : non utilisé.

Autres comportements utiles :
- `estimated_nb_files` : l'upload_set se complète automatiquement quand ce nombre de fichiers est
  reçu (`mark_upload_set_completed_if_needed`) ; on appelle quand même `/complete` en fin d'envoi.
- Doublons : MD5 du fichier ; renvoyer le même fichier dans le même set → 409 avec
  `existing_item.id` (traité comme « déjà envoyé » à la reprise). Dans un autre set → rejet
  `file_duplicate` si l'instance refuse les doublons.
- « Terminé » = `dispatched` **et** toutes les `associated_collections[].ready` (le traitement
  des images, floutage compris, continue après l'envoi).

### 2.3 Attributs sémantiques

Format : `[{"key": "transport", "value": "bike"}]` (suppression : `"action": "delete"`).
Les `semantics` d'un upload_set sont **copiées sur chaque collection créée au dispatch**
(`copy_upload_set_semantics_to_sequence`) et, si on les modifie après dispatch, propagées aux
collections associées. Avec 1 upload_set = 1 séquence, les attributs de séquence sont donc posés
au bon niveau (la collection). Correction possible ensuite via `PATCH /api/collections/{id}`
(`semantics`).

### 2.4 Heading — **piège important**

Après dispatch, le serveur recalcule le cap depuis la trajectoire (`utils/sequences.py`,
`update_headings`) **pour les photos dont le cap est NULL, = 0, ou déjà calculé**, sauf si un
`relative_heading` est défini (alors il recalcule *tout*).

Conséquences pour l'application :
1. Écrire `GPSImgDirection` + `GPSImgDirectionRef=T` dans les copies (prévu).
2. **Ne jamais envoyer `relative_heading`** : il écraserait nos caps. Le décalage angulaire de
   séquence est appliqué localement, dans la valeur écrite.
3. Le serveur arrondit à l'entier et **un cap arrondi à 0 est considéré comme absent** et
   recalculé. Règle : si le cap final arrondi vaut 0, écrire 359.6° (→ 360 ≡ 0°) — à valider sur
   une instance de test ; à défaut, 1° (écart de 1° documenté et signalé dans le contrôle qualité).
4. ~~Écrire aussi `XMP-GPano:PoseHeadingDegrees` avec la même valeur~~ — **corrigé (2026-11)** : le lecteur
   Panoramax interprète `PoseHeadingDegrees` comme le lacet (décalage du centre de l'image par rapport à
   `GPSImgDirection`) ; une photo GoPro MAX correctement étiquetée le garde à 0,0. Ne pas suivre le writer
   officiel (`geopic_tag_reader/writer.py`), pour éviter deux caps contradictoires.

### 2.5 Positions

La position corrigée est **écrite dans les EXIF de la copie** (`GPSLatitude/Longitude` + Ref)
plutôt que via `override_latitude/longitude` : le fichier préparé est autonome et vérifiable,
l'export reste utilisable hors Panoramax. Les `override_*` restent une solution de secours.

---

## 3. Architecture définitive

```
panoramax-preprocess/
├── backend/              Python 3.12+, FastAPI, SQLite (WAL)
│   ├── app/api/          routes REST (projets, photos, séquences, corrections, publication)
│   ├── app/core/         géodésie, heading, interpolation, découpage (pur Python, testé)
│   ├── app/exif/         lecture (exiftool -stay_open, par lots) / écriture copies
│   ├── app/jobs/         file de tâches (thread pool + table jobs SQLite, reprise au redémarrage)
│   ├── app/panoramax/    client API (httpx), auth, upload, suivi
│   └── tests/
├── frontend/             React + TypeScript + Vite, MapLibre GL JS
│   └── src/ (map/, viewer/, timeline/, sequences/, panels/, store/)
└── run.sh                lance le backend qui sert aussi le frontend construit
```

Choix et justifications (sans sur-ingénierie) :

- **Un seul processus** : FastAPI sert l'API et le frontend statique ; `http://127.0.0.1:8765`.
  Pas de Celery/Redis : une file de tâches en threads, persistée dans SQLite, suffit pour une
  machine locale et survit à un redémarrage.
- **ExifTool en mode `-stay_open`** (via `pyexiftool`) : lecture de ~5 000 photos en lots de 200
  en quelques dizaines de secondes ; écriture **sans recompression** (ExifTool réécrit seulement
  les segments de métadonnées).
- **pyproj.Geod (WGS84)** : azimut, distance, interpolation géodésique.
- **Miniatures** : Pillow `draft()` (décodage JPEG à 1/8 → très rapide) en 512 px, cache disque
  par projet ; tâche d'arrière-plan, la carte est utilisable dès la fin de la lecture EXIF.
- **Carte** : MapLibre avec **une source GeoJSON** de toutes les photos (couche cercle +
  couche symbole flèche orientée par `heading`) ; mise à jour incrémentale via `setData` ciblé /
  `feature-state`. 10 000 points en WebGL restent fluides sans clustering ; clustering seulement
  au zoom < 12.
- **Visionneuse 360°** : Photo Sphere Viewer (ou Pannellum) sur l'image complète servie par le
  backend, avec bascule vue plate (équirectangulaire zoomable). Préchargement de la photo
  suivante/précédente.
- **Listes/timeline** : virtualisées (`@tanstack/react-virtual`) ; timeline en canvas.
- **État** : Zustand ; annuler/rétablir côté backend (journal d'opérations).
- **Jeton Panoramax** : `keyring`.

### Schéma SQLite (principal)

```
project(id, name, created_at, settings_json)              -- 1 fichier .sqlite par projet
photo(id, path, size, mtime, sha1_head, filename,
      ts_orig, subsec, lat_orig, lon_orig, alt, heading_exif,
      is_360, width, height, status, anomalies_json,
      lat, lon, pos_method,                                -- position corrigée (NULL = originale)
      heading_auto, heading_auto_state,                    -- ok | uncertain | missing
      heading_manual, heading_stale,                       -- manual jamais écrasé
      sequence_id, rank)
sequence(id, name, color, heading_offset, time_offset_s,
         semantics_json, state, created_at)
op_log(id, ts, kind, payload_json, inverse_json, undone)   -- undo/redo + historique
correction(photo_id, ts, field, old, new, method, op_id)   -- historique par photo
gpx_point(track_id, ts, lat, lon, ele)
job(id, kind, state, progress, payload_json, error)
publish_set(sequence_id, instance_url, upload_set_id, state, collection_id, ...)
publish_file(sequence_id, photo_id, prepared_path, md5, state, picture_id, rejection)
```
Index sur `photo(ts_orig)`, `photo(sequence_id, rank)`, `publish_file(state)`.

Cap final = `heading_manual` si présent, sinon `(heading_auto + sequence.heading_offset) mod 360`.

### Algorithmes clés

- **Correction de retard GPS** : pour une photo à l'instant t et un retard d, la position
  réelle est la position *enregistrée* à t + d. On interpole sur la trajectoire des positions
  originales indexée par le temps (interpolation géodésique entre les deux points encadrants ;
  dans un virage serré on interpole le long de la polyligne — Catmull-Rom centripète en
  coordonnées locales — au lieu d'une corde). Calibration : minimisation 1D (recherche dorée sur
  d ∈ [0 ; 5] s) de la somme des distances entre positions corrigées et positions indiquées.
- **Heading** : azimut vers le premier point suivant à distance ≥ D_min (défaut 3 m) dans une
  fenêtre de 10 s ; si arrêt/aucun point → « incertain » (pas de valeur inventée) ;
  sauts aberrants (vitesse > seuil) exclus ; moyenne circulaire courte pour le bruit, sans lisser
  au-delà d'un seuil de variation (virages préservés).
- **Coupures proposées** : écart de temps > N s, distance > M m, vitesse impossible ;
  proposées, jamais appliquées sans validation.

---

## 4. Plan de réalisation

| Phase | Contenu | Livrable vérifiable |
|---|---|---|
| **2a** | squelette backend/frontend, projets, import récursif, lecture EXIF par lots, bilan d'import, miniatures en tâche de fond | importer 5 000 photos, bilan affiché, redémarrage sans perte |
| **2b** | carte (fonds OSM / Esri / OpenTopoMap / XYZ perso), visionneuse 360 + navigation clavier, timeline, liste virtualisée | parcourir 5 000 photos fluidement |
| **2c** | séquences (début/fin, créer, scinder, fusionner, renommer, photos non classées), undo/redo | découper une sortie en quelques touches |
| **2d** | correction GPS individuelle et par lot, heading auto + manuel + par plage + par séquence, préparation des copies EXIF, exports GeoJSON/CSV | copies avec GPSImgDirection vérifiées par exiftool, originaux intacts (hash) |
| **3** | retard GPS + calibration, détection d'anomalies, coupures proposées, import GPX, magnétisme OSM facultatif | — |
| **4** | auth par jeton réclamé, attributs (`transport=bike` par défaut), upload (1 upload_set/séquence, envois parallèles, reprise via `GET …/files`), suivi jusqu'à `ready`, historique, liens | publier une séquence sur une instance de test |
| **5** | jeu de 5 000–10 000 photos, profilage, optimisation | — |

Tests unitaires (pytest) dès la phase 2 : azimut, interpolation, retard GPS, heading, découpage,
écriture EXIF (sur JPEG générés), préparation Panoramax. Tests d'intégration Panoramax avec
l'instance Docker officielle (`server/api` docker-compose) si disponible localement.

---

## 5. Ce qu'il me faut pour avancer

1. **Un échantillon réel** : 20–50 photos GoPro MAX d'une même sortie (idéalement avec un arrêt et
   un virage), et si possible un fichier d'une autre sortie / autre firmware. Je fournirai un
   script `analyse_gopro.py` qui produit le rapport des champs EXIF/XMP/MakerNotes.
2. ~~Où créer le projet~~ : dépôt `qhess34/panoramax-preprocess`.
3. **Instance de test Panoramax** pour la phase 4 (ou accord pour publier sur l'instance OSM-FR
   avec une visibilité `owner-only` pendant les essais).
