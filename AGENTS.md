# AGENTS.md — GeoSillage

Consignes pour les agents IA (et les humains) qui travaillent sur ce dépôt. À lire avant toute modification.

## Le projet

Application **locale** (FastAPI + React) qui prépare des sorties de photos 360° GoPro MAX avant publication sur
Panoramax : import, découpe en séquences, retard GPS, positions, caps et orientation, export d'un dossier par
séquence avec EXIF corrigés (ExifTool), publication sur une instance Panoramax (une séquence = un envoi, depuis son
dernier export). Deux types de projet : **sortie** (photos du disque) et **Panoramax** (séquences déjà publiées,
photos laissées sur l'instance : corrections renvoyées, pas de découpe ni d'export ; `routes_edit.ride_only`).

Docs (`doc/`) : `GUIDE_UTILISATEUR.md` (usage, écran par écran) · `DEVELOPPEMENT.md` (installation, vérifications,
recettes, conventions) · `GUIDE_CODE.md` (modules, données, algorithmes, pièges ; sommaire en tête) ·
`ETUDE_PHASE1.md` (GoPro MAX, API Panoramax) · `ORGANISATION_IA.md` (organisation IA : rôles, choix du modèle, cycle d'une demande, environnements).

## Où modifier quoi

Serveur : `backend/app/` — `main.py` (projets, photos, import, fichiers, sert l'interface), `routes_edit.py`
(séquences, annuler, caps, orientation, positions, synchro, export), `core/` (calculs purs), `db.py` / `undo.py` /
`jobs.py` (SQLite + migrations, journal, tâches), `exporter.py` + `exif/`, `panoramax.py` + `routes_publish.py`.
Tests : `backend/tests/` (photos simulées par `tools/make_samples.py`), `e2e/tests/` (Playwright).
Interface : `frontend/src/ProjectView.tsx` (écran principal) + `shortcuts.ts`, `useIssues.ts`, `contextMenuItems.ts`,
`PhotoTab`, `SummaryTab`, `ProjectDialogs`, `JobBar`, `PhotoMap`, `Timeline`, `Viewer360`, `api.ts`.

| Fonction | Serveur | Interface (tests) |
|---|---|---|
| Import | `importer.py`, `main.py` | `ImportDialog`, `FsBrowser` (`test_import`, e2e `files`) |
| Séquences, exclusion, annuler | `core/sequences.py`, `undo.py`, `routes_edit.py` | `SequencesTab`, `shortcuts.ts` (e2e `edits`) |
| Raccourcis, menu contextuel | — | `shortcuts.ts`, `contextMenuItems.ts`, `HelpDialog` (e2e `navigation`) |
| Synchro (retard GPS), GPX | `core/timesync.py`, `core/gpx.py` | `SyncTab`, `Gpx.tsx` (`test_timesync`, `test_gpx`) |
| Positions, recalage OSM | `core/positions.py`, `core/osm.py` | `PhotoTab`, `OsmSnapPanel` (`test_positions_sources`, `test_osm`) |
| Caps et orientation | `core/headings.py` | `PhotoTab`, `SummaryTab`, `HeadingDial`, `YawRotate` (`test_headings`) |
| Points à vérifier, arrêts | `core/quality.py`, `core/analysis.py` | `issues.ts`, `IssuesPanel`, `StopRangeEditor` (`test_quality`, e2e `issues`) |
| Réglages | `config.DEFAULT_SETTINGS`, `main.SettingsIn` | `SettingsDialog` |
| Export, EXIF | `exporter.py`, `exif/` | `ExportTab` (`test_export`) |
| Publication / projet Panoramax | `panoramax.py`, `routes_publish.py` | `Publication`, `SendTab`, `PublishedEdit` (`test_publish`) |
| Carte, fonds, surcouche | — | `PhotoMap`, `basemaps.ts`, `panoramaxLayer.ts`, `MapLegend` |

Vérifications : `tools/check.sh [back|front|e2e|all]` (voir plus bas). Captures du guide : `tools/captures.sh`
(plusieurs minutes, **seulement à la demande de l'utilisateur**). `ProjectView.tsx` est long (~1 000 lignes) :
chercher (`grep -n`) plutôt que le lire en entier.

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
- **Langue** : interface en **français et anglais** (`frontend/src/i18n/` : `fr.ts` référence, `en.ts`, repli sur le
  français ; tout nouveau texte d'interface y passe, jamais en dur ; chantier #37) ; erreurs du serveur en français (clé) avec traduction anglaise dans
  `backend/app/i18n.py` (table `EN`, langue = en-tête `Accept-Language`), documentation et
  commits en **français** ; code et commentaires en anglais, courts.
- **Documentation dans le même commit** : `GUIDE_UTILISATEUR.md` **et** `USER_GUIDE.md` (anglais, mêmes sections) pour tout
  changement visible (leurs captures, `tools/captures.sh` puis `CAPTURE_LANG=en tools/captures.sh`, seulement quand
  l'utilisateur le demande), `GUIDE_CODE.md` pour le fonctionnement, ce fichier si une règle
  ou l'organisation change.
- **Ne pas prétendre avoir vérifié** ce qui ne peut pas l'être hors ligne (tuiles réelles, site Panoramax) : le
  dire.

## Contribuer sobrement (agents IA)

Pour limiter le temps et les tokens consommés :

- **Une session par lot cohérent** de travail, archivée une fois la PR fusionnée ; une suite se reprend dans une
  session neuve avec le lien de la PR. Au plus 1 à 3 PR par session.
- **Regrouper les petites corrections dans une seule PR** (une branche, un passage du CI) ; une PR à part seulement
  pour un changement important ou risqué.
- **Tests plutôt que captures** : pytest et e2e (« 10 passed ») suffisent pour un comportement. Une capture seulement
  pour une mise en page nouvelle, **recadrée** sur la zone modifiée.
- **Captures du guide (`tools/captures.sh`) : uniquement quand l'utilisateur le demande.** Une PR qui change un
  écran montré dans le guide ne régénère pas : elle ajoute la ou les captures concernées (`doc/images/` et
  `doc/images/en/` ; nom, changement, numéro de
  PR) à l'issue ouverte « Mettre à jour les captures du guide » (label `documentation`), ou la crée si aucune n'est
  ouverte. La PR qui régénère les captures ferme l'issue (« Closes #… »).
- **Tests ciblés pendant la mise au point** (`tools/check.sh back tests/test_osm.py`, `e2e --grep …`), suite complète
  une seule fois avant le push ; pousser une fois les vérifications locales vertes.
- **Attendre le CI avec `subscribe_pr_activity`**, jamais de polling. Journaux : seulement l'issue des vérifications,
  le journal d'un job seulement s'il échoue, sur les dernières lignes (`tail`, `grep`).
- **Lire une section, pas le fichier** : `grep -n '^## ' doc/GUIDE_CODE.md` puis `sed -n 'a,bp'` ; idem pour le code
  (carte rapide ci-dessus).
- **Modèle / effort** : léger pour textes, CSS et petits défauts ; élevé pour caps, orientation, EXIF, synchro et
  publication.
- **Docs** : modifier seulement la section concernée, en restant concis ; condenser une section qui dépasse ~60 lignes.

## Vérifier avant de committer

```sh
tools/check.sh all     # pytest + tsc/vite + Playwright ; n'affiche que l'essentiel, code non nul si échec
tools/check.sh back [fichier de test]   |   front   |   e2e [--grep motif]
```

Une fonction nouvelle ou corrigée dans l'interface s'accompagne d'un test dans `e2e/tests/` (`doc/DEVELOPPEMENT.md`
§ 3). Pour un nouvel écran ou une mise en page : regarder aussi une capture à 1280 et 1024 px (application pour
ordinateur : pas d'affichage pour téléphone). GitHub Actions (`.github/workflows/ci.yml`) relance tests backend,
construction, tests d'interface et image Docker à chaque push : après le push, vérifier que les vérifications
passent.

## Pièges fréquents

ExifTool, MapLibre, SQLite (verrou), rechargement des photos, Docker : voir `doc/GUIDE_CODE.md` § « Pièges connus ».
