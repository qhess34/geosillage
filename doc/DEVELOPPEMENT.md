# Guide du développeur

Pour les humains et les agents IA qui modifient GeoSillage. Les règles courtes sont dans
[`AGENTS.md`](../AGENTS.md) ; le fonctionnement interne détaillé (modules, données, algorithmes, pièges) dans
[`GUIDE_CODE.md`](GUIDE_CODE.md) ; l'étude de départ (GoPro MAX, API Panoramax) dans
[`ETUDE_PHASE1.md`](ETUDE_PHASE1.md) ; l'utilisation dans [`GUIDE_UTILISATEUR.md`](GUIDE_UTILISATEUR.md).

## 1. Architecture en bref

```
navigateur (React 18 + TypeScript, Vite)          un seul processus local, 127.0.0.1:8765
  ProjectView ── api.ts ──HTTP/JSON──►  FastAPI  backend/app/main.py      projets, photos, import, fichiers
                                                 backend/app/routes_edit.py séquences, caps, positions, synchro, export
                                                   │
                                     core/ (calculs purs) · undo.py · jobs.py (threads) · exporter.py
                                                   │
                         SQLite par projet (<data>/projects/<id>/project.sqlite)   ExifTool (sous-processus)
```

- **Un projet = une base SQLite** + un dossier de miniatures. Les photos sources ne sont que référencées.
- **Valeurs d'origine jamais réécrites** dans la base (`*_orig`, `heading_exif`…) ; les corrections sont dans
  d'autres colonnes (`lat`/`lon` + `pos_method`, `heading_manual`, `yaw_offset`…).
- **Toute modification est annulable** (`undo.undoable`) et marque les séquences touchées « à réexporter ».
- **Tâches longues** (import, miniatures, export, restauration) : `jobs.start(pid, kind, fn)` dans un thread ;
  l'interface interroge `GET /api/projects/{id}` (liste `jobs`) toutes les secondes pendant qu'une tâche tourne.
- **EXIF** : lecture et écriture uniquement par ExifTool (`exif/reader.py`, `exif/writer.py`), jamais de
  recompression.
- **Interface** : pas de gestionnaire d'état ; `ProjectView.tsx` tient l'état (photos, séquences, sélection, plage,
  modes) et le passe aux composants et aux hooks (`useShortcuts`, `useIssues`). Carte MapLibre GL, visionneuse Photo Sphere Viewer.

## 2. Installer l'environnement

Prérequis : Python ≥ 3.11, Node.js ≥ 20 (22 dans l'image Docker), ExifTool (`libimage-exiftool-perl` ; les tests
sont faits avec la 12.76).

```sh
python3 -m venv .venv && .venv/bin/pip install -r backend/requirements-dev.txt
(cd frontend && npm ci)
```

Lancer :

```sh
cd backend && ../.venv/bin/uvicorn app.main:app --reload --port 8765   # API (+ interface construite si frontend/dist existe)
cd frontend && npm run dev                                              # interface en développement : http://127.0.0.1:5173 (proxy /api → 8765)
```

Variables : `PSS_DATA_DIR` (projets ; défaut `~/.local/share/panoramax-studio`), `PSS_DEFAULT_DIR` (dossier ouvert
par les sélecteurs), `PSS_EXIFTOOL` (chemin d'ExifTool), `PSS_OVERPASS_URL` (serveur Overpass pour le recalage OSM ; défaut
`https://overpass-api.de/api/interpreter`), `PORT` (`run.sh`, Docker).

Jeu de photos simulées (format GoPro MAX, retard GPS, bruit, sauts, interruption, doublon, fichier corrompu, vérité
terrain en CSV) :

```sh
.venv/bin/python tools/make_samples.py /tmp/sortie --count 500 --width 1024
```

## 3. Vérifier un changement

**Ces vérifications sont à faire avant chaque commit.** GitHub Actions (`.github/workflows/ci.yml`, « Vérifications »)
relance à chaque push et pull request les tests backend (avec ExifTool), la construction de l'interface, les tests
d'interface (Playwright) et la construction de l'image Docker : ✅ / ❌ à côté de chaque commit ; en cas d'échec des
tests d'interface, le rapport (captures des tests en échec) est joint au lancement (« rapport-playwright »).

| Quoi | Commande | Attendu |
|---|---|---|
| Tests backend | `cd backend && ../.venv/bin/python -m pytest -q` | tous verts (~1 min) |
| Types + construction de l'interface | `cd frontend && npm run build` | `✓ built`, aucune erreur `tsc` |
| Tests d'interface | `cd e2e && npm test` (après `npm run build` dans `frontend/`) | tous verts (~20 s) |
| Nouvel écran ou mise en page | Playwright (ci-dessous) + capture | aucune erreur JavaScript ; affichage à 1280 et 1024 px (pas d'affichage pour téléphone) |
| Image Docker (si `Dockerfile`, dépendances) | `docker compose build` | construction OK |

### Tests d'interface (`e2e/`)

`e2e/` : suite `@playwright/test` (version identique au Playwright installé, pour réutiliser son Chromium ;
`npm install` une fois dans `e2e/`). `serve.sh` (lancé par Playwright) démarre le vrai backend, qui sert l'interface
construite, sur un dossier de données neuf, avec une sortie simulée (160 photos, générée une fois dans
`e2e/.cache/`). Chaque test crée son propre projet par l'API (`newProject` dans `tests/helpers.ts`, réglages
optionnels) : les tests sont indépendants et tournent en parallèle. Le fixture commun bloque les tuiles et fait
échouer le test à la moindre erreur JavaScript de la page. Couvert : navigation (clavier, timeline), aide `?`,
séquence D / F + annulation, exclusion X, timeline sans les exclues, réglage refusé, liste « À corriger » et fiche,
arrêt (ajuster, comparer, tout exclure), import (sous-dossiers, fil d'Ariane), GPX (import, décalage, aperçu,
recalage, annulation). **Une fonction nouvelle ou corrigée = un test ici.** Pièges : attendre l'état affiché avant
de cliquer (ex. l'étape « … arrêts à trier » avant d'ouvrir sa liste) et lire la photo avec `pickOnTimeline` /
`expect.poll` (les photos se rechargent après chaque action). `npm run test:trace` garde la trace d'exécution pour
déboguer un échec.

### Script ponctuel (Playwright)

L'interface est servie par le backend une fois construite (`frontend/dist`). Démarrer le backend sur un dossier de
données jetable, créer un projet et importer des photos simulées par l'API, puis piloter un navigateur :

```sh
export PSS_DATA_DIR=/tmp/pss-e2e
(cd backend && ../.venv/bin/uvicorn app.main:app --port 8765 &)
PID=$(curl -s -X POST localhost:8765/api/projects -H 'Content-Type: application/json' -d '{"name":"Essai"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -s -X POST localhost:8765/api/projects/$PID/import -H 'Content-Type: application/json' -d '{"paths":["/tmp/sortie"]}'
```

```js
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const errors = [];
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });   // refaire à 1024 px de large
  await p.route(/tile\.openstreetmap|arcgisonline|opentopomap|geopf|\.mvt/, r => r.fulfill({ status: 204 })); // pas de tuiles réseau
  p.on('pageerror', e => errors.push(e.message));
  await p.goto('http://127.0.0.1:8765/');
  await p.click('.project-name:has-text("Essai")'); await p.waitForSelector('.tabs');
  await p.keyboard.press('Home'); await p.keyboard.press('ArrowRight');
  console.log(await p.locator('.photo-title .muted').innerText());          // « 2 / N »
  console.log('errors', errors); await b.close();
})();
```

Repères utiles : `.tabs` / `.tab:has-text("Séquences")`, `.seq` (une séquence), `.export-list li`,
`canvas.timeline`, `.maplibregl-marker` (marqueur violet du mode Positions), `.toast` (messages),
`window.__pssMap` (instance MapLibre, pour `queryRenderedFeatures`, `project`…). Les boîtes `window.confirm` se
gèrent avec `p.once('dialog', d => d.accept())`. Après une action, attendre ~0,5 s (rechargement des photos).

Ce qui ne peut pas être testé hors ligne : les vraies tuiles (IGN, Esri, Panoramax), le comportement du site
Panoramax. Pour la surcouche Panoramax, un faux serveur de tuiles (`mapbox-vector-tile`) suffit.

### Captures d'écran du guide d'utilisation

`tools/captures.sh` régénère `doc/images/*.webp` (seulement à la demande de l'utilisateur ; en attendant, les écrans à refaire sont listés dans l'issue « Mettre à jour les captures du guide », voir AGENTS.md) : sortie simulée près de Montpellier (400 photos), projet de
démonstration créé par l'API (séquences, exclusion, synchro, orientation, exports), puis `tools/captures.js`
(Playwright) prend les captures à 1280 × 760 px, en thème clair. Il faut le réseau vers
`tile.openstreetmap.org`, `data.geopf.fr` et `api.panoramax.xyz` (vraies tuiles et vraie surcouche Panoramax), un
`.venv` avec les dépendances de développement, et l'interface construite. Les photos et exports vont dans `/photos`
et `/exports` (comme sous Docker, pour qu'aucun chemin local n'apparaisse) ; sinon `PHOTOS_DIR` / `EXPORTS_DIR`.
À relancer quand un écran montré dans le guide change, puis regarder les images avant de committer.

## 4. Recettes

### Ajouter une route qui modifie le projet

Dans `routes_edit.py` (préfixe `/api/projects/{pid}`) :

```python
class FooIn(BaseModel):
    photo_ids: list[int] = Field(min_length=1)
    value: float = Field(ge=-360, le=360)          # toujours borner les entrées

@router.post("/foo")
def foo(pid: str, body: FooIn):
    with db.open_project(pid) as conn:
        with undo.undoable(conn, f"Foo sur {len(body.photo_ids)} photo(s)"):   # libellé affiché dans « Annuler »
            core_module.do_foo(conn, body.photo_ids, body.value)
        headings.recompute(conn)                   # si positions / séquences changent (caps dérivés)
        return _state(conn)                        # séquences + état annuler/rétablir pour l'interface
```

- La logique va dans `core/` (fonctions sur une connexion, sans HTTP), testée par pytest.
- Erreur destinée à l'utilisateur : `HTTPException(409, "message en français")` (ou une exception métier
  convertie, comme `_pos_errors`).
- Côté interface : une méthode dans `api.ts`, puis `applyState(s)` (réponse avec séquences) ou
  `afterHeadingChange(r.undo)` (recharge photos et séquences).

### Ajouter une colonne éditable

1. Ajouter une migration **à la fin** de `db.MIGRATIONS` (jamais modifier une migration existante) :
   `"ALTER TABLE photo ADD COLUMN foo REAL"`.
2. L'ajouter à `undo.PHOTO_COLS` (ou `SEQ_COLS`) : sinon annuler/rétablir l'ignore, et les séquences ne sont pas
   marquées « à réexporter ».
3. Si l'interface en a besoin : liste des champs de `GET …/photos` (`main.py`) et `PhotoRow` dans `api.ts`.
4. Un test : la migration s'applique à une base existante, et annuler remet la valeur.

### Écrire une nouvelle balise à l'export

`exif/writer.py` (construction des arguments ExifTool) et `exporter.py` (valeur par photo). Règles :
- les options ExifTool doivent être **répétées pour chaque commande** d'un fichier d'arguments (`-execute`) ;
- seules les lignes qui commencent par `Error` sont des erreurs (les `Warning` des makernotes GoPro sont normaux) ;
- avec `-n`, valeurs numériques (`GPSVersionID` = `2 3 0 0`) ;
- pour une source (modes *Déplacer* / *Sur place*) : sauvegarder la valeur d'origine dans `orig_tags` (`_captured`)
  avant la première écriture, et la remettre dans `restore_sources` ;
- ajouter la balise à la relecture de vérification et à `test_export.py`.

### Ajouter un réglage d'interface mémorisé

État React initialisé depuis `localStorage['pss-…']` dans un `try` (stockage indisponible possible), valeur par
défaut si absent ; écrire dans un `try` aussi. Exemples : `pss-follow`, `pss-show-excluded`,
`pss-carry-position`, `pss-yaw-angle`, `pss-panoramax-overlay`.

### Ajouter un raccourci clavier

Gestionnaire `onKey` de `useShortcuts` (`shortcuts.ts`, ignoré quand un champ de saisie a le focus ou qu'une fenêtre
est ouverte) ; ajouter la touche au tableau `SHORTCUTS` du même fichier (aide `?`) et au guide utilisateur (§ 10) ; une
valeur ou fonction nouvelle passe par `ShortcutsParams` (lue au dernier rendu, pas de liste de dépendances). Une case à cocher qui
change le comportement des flèches doit perdre le focus après le clic (`e.target.blur()`).

### Ajouter un fond de carte

`frontend/src/basemaps.ts` : identifiant, nom, URL de tuiles, `maxzoom` réel du service, attribution.

## 5. Conventions

- **Langue** : interface, messages d'erreur, documentation et messages de commit en **français** ; code,
  identifiants et commentaires en **anglais**, courts.
- **Commits** : un sujet court au présent (« Positions : report de la correction… »), puis des tirets.
- **Documentation dans le même commit** que le code : `GUIDE_CODE.md` (fonctionnement), `GUIDE_UTILISATEUR.md`
  (tout changement visible), `README.md` si l'installation change, `AGENTS.md` si une règle change.
- **Pas de nouvelle dépendance** sans raison forte ; versions exactes dans `package.json`.
- **Texte venant des photos ou d'un serveur** (noms, EXIF, réponses Panoramax) : jamais inséré comme HTML
  (`textContent`, rendu React).
- **Sécurité** : l'API donne accès au système de fichiers ; elle n'écoute que sur `127.0.0.1` (Docker : port publié
  sur `127.0.0.1`). Identifiant de projet vérifié (hexadécimal) avant tout accès disque.

## 6. Points délicats

- **Orientation et Panoramax** (`GUIDE_CODE.md` « Orientation ») : `GPSImgDirection` = sens de déplacement ;
  `PoseHeadingDegrees` = lacet au sens du `sphereCorrection.pan` du viewer Panoramax ; le viewer n'applique le
  lacet que si tangage **et** roulis ≠ 0, d'où 0,01°. Les flèches de navigation Panoramax sont placées par rapport
  à `view:azimuth` (= `GPSImgDirection`).
- **Cap 0** : Panoramax recalcule un cap nul ; l'export écrit 0,6° (option *Compatibilité Panoramax*).
- **Rechargement asynchrone** : après une action, les photos sont rechargées un peu plus tard ; un raccourci pressé
  entre-temps voit l'ancien état (voir `lastCarry` pour le report de position).
- **Carte MapLibre** : `zoom` au premier niveau des expressions, pas de `null` dans les filtres, `setStyle(…, {diff:
  false})` (détails dans `GUIDE_CODE.md` « Pièges connus »).
- **Tâches courtes** : une tâche peut se terminer avant le premier rafraîchissement ; l'interface surveille la liste
  des tâches terminées (`finishedJobs`), pas seulement le passage « en cours → fini ».
