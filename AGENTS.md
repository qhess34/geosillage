# AGENTS.md — GeoSillage

Consignes pour les agents IA (et les humains) qui travaillent sur ce dépôt. À lire avant toute modification.

## Le projet

Application **locale** (FastAPI + React) qui prépare des sorties de photos 360° GoPro MAX avant publication sur
Panoramax : import, découpe en séquences, retard GPS, positions, caps et orientation, export d'un dossier par
séquence avec EXIF corrigés (ExifTool), publication sur une instance Panoramax (une séquence = un envoi, depuis son
dernier export). Deux types de projet : **sortie** (photos du disque) et **Panoramax** (séquences déjà publiées,
photos laissées sur l'instance : corrections renvoyées, pas de découpe ni d'export ; `routes_edit.ride_only`).

| Document | Contenu |
|---|---|
| `doc/GUIDE_UTILISATEUR.md` | utilisation de l'outil, écran par écran, raccourcis, questions fréquentes |
| `doc/DEVELOPPEMENT.md` | installation, vérifications (tests, construction, Playwright), recettes, conventions |
| `doc/GUIDE_CODE.md` | fonctionnement interne : modules, données, algorithmes, pièges connus |
| `doc/ETUDE_PHASE1.md` | étude GoPro MAX et API Panoramax (découpage, doublons, cap) |

## Organisation

| Chemin | Contenu |
|---|---|
| `backend/app/main.py` | API projets, photos, import, fichiers ; sert l'interface construite |
| `backend/app/routes_edit.py` | API séquences, annuler/rétablir, caps, orientation, positions, synchro, export |
| `backend/app/core/` | calculs purs : géodésie, analyse, caps, séquences, positions, synchro, recalage OSM (`osm.py`, Overpass) |
| `backend/app/db.py`, `undo.py`, `jobs.py` | SQLite par projet + migrations, journal annuler/rétablir, tâches de fond |
| `backend/app/exporter.py`, `exif/` | export, modification/restauration des sources, lecture/écriture ExifTool |
| `backend/app/panoramax.py`, `routes_publish.py` | connexion à une instance Panoramax (lien de validation), publication par séquence |
| `backend/tests/` | pytest (photos simulées par `tools/make_samples.py`) |
| `frontend/src/ProjectView.tsx` | écran principal : état, barre d'outils, onglets, raccourcis clavier |
| `frontend/src/*.tsx`, `*.ts` | carte (`PhotoMap`), timeline, visionneuse 360°, onglets, surcouche Panoramax, API (`api.ts`) |

## Carte rapide : où modifier quoi

| Fonction | Serveur | Interface | Tests |
|---|---|---|---|
| Import, miniatures, sélecteur de dossiers / fichiers | `importer.py`, `main.py` (`/api/fs`) | `ImportDialog`, `FsBrowser`, `FolderPicker` | `test_import`, e2e `files` |
| Séquences (D / F, couper, fusionner, limites) | `core/sequences.py`, `routes_edit.py` | `SequencesTab`, `ProjectView` (raccourcis) | `test_export`, e2e `edits` |
| Exclusion, annuler / rétablir | `undo.py`, `routes_edit.py` | `ProjectView`, `Timeline` (`hideExcluded`) | e2e `edits` |
| Synchro (retard GPS) | `core/timesync.py` | `SyncTab`, `timesync.ts`, `PhotoMap` (marqueur, aperçu) | `test_timesync` |
| Trace GPX (référence synchro, recalage sur la ligne) | `core/gpx.py`, routes `/gpx` | `Gpx.tsx` | `test_gpx`, e2e `gpx` |
| Positions (glisser, interpolation, report) | `core/positions.py` | `ProjectView`, `PhotoMap` (mode Positions) | `test_positions_sources` |
| Recalage OSM | `core/osm.py` | `OsmSnapPanel` | `test_osm` |
| Caps et orientation | `core/headings.py` | `ProjectView` (onglet Photo), `HeadingDial`, `CapOrientation`, `YawRotate`, `Viewer360` | `test_headings` |
| Points à vérifier (arrêts, écarts, DOP, caps, sans cap…) | `core/quality.py`, `core/analysis.py` | `issues.ts` (textes, liste), `IssuesPanel`, `CheckCard`, `StepBar` | `test_quality`, e2e `issues` |
| Arrêts (ajuster, comparer, exclure) | — | `StopRangeEditor`, `StopCompare` | e2e `issues` |
| Réglages (seuils, cap, surcouche) | `config.DEFAULT_SETTINGS`, `main.SettingsIn` | `SettingsDialog` | e2e `edits` |
| Export, EXIF | `exporter.py`, `exif/` | `ExportTab` | `test_export` |
| Publication / projet Panoramax | `panoramax.py`, `routes_publish.py` | `Publication`, `SendTab`, `PublishedEdit`, `NewPanoramaxProject` | `test_publish` |
| Carte, fonds, surcouche Panoramax, légende | — | `PhotoMap`, `basemaps.ts`, `panoramaxLayer.ts`, `MapLegend` | — |

Commandes : `cd backend && ../.venv/bin/python -m pytest -q` (~75 s) · `cd frontend && npm run build` ·
`cd e2e && npm test` (~20 s, après la construction) · captures du guide : `tools/captures.sh` (plusieurs minutes, seulement
si un écran montré change). `ProjectView.tsx` est long (~1 800 lignes) : chercher (`grep -n`) plutôt que le lire en entier.

## Règles

- **Ne jamais perdre une photo ni une valeur d'origine.** Les sources ne sont modifiées que par l'export en modes
  *Déplacer* / *Sur place*, après confirmation, avec sauvegarde des balises d'origine et restauration possible.
  Rien n'est supprimé du disque (photos exclues : dossier `_exclues`).
- **Toute modification passe par `undo.undoable`** ; toute nouvelle colonne éditable va dans `undo.PHOTO_COLS` /
  `SEQ_COLS`. Migrations : uniquement ajoutées à la fin de `db.MIGRATIONS`.
- **Action en masse = confirmation** (ex. exclusion d'une plage), et message indiquant `Ctrl+Z`.
- **EXIF et Panoramax** : `GPSImgDirection` = sens de déplacement ; `XMP-GPano:PoseHeadingDegrees` = lacet au sens du
  viewer Panoramax, avec tangage/roulis à 0,01° quand il est écrit ; jamais de recompression JPEG ; cap 0 écrit
  0,6°. Lire `GUIDE_CODE.md` « Orientation » et « Export » avant d'y toucher.
- **Jeton Panoramax** : stocké seulement dans `<DATA_DIR>/panoramax.json` (droits 600), jamais renvoyé à
  l'interface ni écrit dans un journal ; jamais `relative_heading` dans un envoi (il écraserait les caps).
- **Sécurité** : l'API ne doit écouter que sur `127.0.0.1` ; texte venant des photos ou de Panoramax jamais inséré
  comme HTML.
- **Langue** : interface, erreurs, documentation et commits en **français** ; code et commentaires en anglais,
  courts.
- **Documentation dans le même commit** : `GUIDE_UTILISATEUR.md` pour tout changement visible (et ses captures,
  `tools/captures.sh`, si un écran montré change), `GUIDE_CODE.md` pour le fonctionnement, ce fichier si une règle
  ou l'organisation change.
- **Ne pas prétendre avoir vérifié** ce qui ne peut pas l'être hors ligne (tuiles réelles, site Panoramax) : le
  dire.

## Vérifier avant de committer

```sh
cd backend && ../.venv/bin/python -m pytest -q     # tous verts
cd frontend && npm run build                        # tsc + vite sans erreur
cd e2e && npm test                                  # tests d'interface Playwright (après la construction)
```

Une fonction nouvelle ou corrigée dans l'interface s'accompagne d'un test dans `e2e/tests/` (`doc/DEVELOPPEMENT.md`
§ 3). Pour un nouvel écran ou une mise en page : regarder aussi une capture à 1280 et 1024 px (application pour
ordinateur : pas d'affichage pour téléphone). GitHub Actions (`.github/workflows/ci.yml`) relance tests backend,
construction, tests d'interface et image Docker à chaque push : après le push, vérifier que les vérifications
passent.

## Pièges fréquents

- ExifTool : options à répéter pour chaque commande d'un fichier d'arguments ; seules les lignes `Error` sont des
  erreurs.
- MapLibre : `zoom` au premier niveau des expressions ; pas de `null` dans les filtres ; `setStyle(…, {diff:false})`.
- Interface : les photos sont rechargées après chaque action ; un raccourci pressé juste après voit l'ancien état.
- Docker : après un changement, l'utilisateur doit reconstruire (`docker compose up -d --build`).
- SQLite : jamais d'opération longue (déplacement de fichier, réseau, ExifTool) dans `db.transaction` : le verrou
  bloque toutes les modifications (« database is locked » au bout de 30 s, renvoyé en 503 avec un message clair).
