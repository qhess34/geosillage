# Guide du code

## Vue d'ensemble

Un seul processus local : FastAPI (`backend/app/main.py`) sert l'API REST sous `/api` et l'interface construite
(`frontend/dist`). Écoute sur `127.0.0.1` uniquement : l'API donne accès au système de fichiers local.

```
backend/app/
  config.py        chemins, nombre de workers, seuils d'analyse par défaut
  db.py            base SQLite par projet, migrations (PRAGMA user_version), drapeaux d'anomalies
  jobs.py          tâches de fond (un thread par tâche, état persistant dans la table job)
  importer.py      scan récursif, hash rapide, lecture EXIF par lots, analyse, miniatures, fichiers introuvables
  exif/reader.py   lecture ExifTool (-json -n -fast, lots de 250 fichiers), dump complet pour inspection
  core/geo.py      géodésie WGS84 (pyproj.Geod) : distance, azimut, longueur de trace
  core/analysis.py ordre chronologique, détection d'anomalies, bilan d'import
frontend/src/
  main.tsx         routage (#/p/<id>), thème clair/sombre/auto
  ProjectList.tsx  création, ouverture, suppression (avec confirmation) des projets
  ProjectView.tsx  barre d'outils, carte, panneau latéral redimensionnable, bilan, barre d'état des tâches
  PhotoMap.tsx     MapLibre : une source GeoJSON (points + trace), couche sélection
  ImportDialog.tsx sélecteur de dossiers (via /api/fs)
  basemaps.ts      fonds de carte (OSM, Esri World Imagery, OpenTopoMap, XYZ personnalisés)
tools/make_samples.py  générateur de sorties GoPro MAX simulées + vérité terrain
```

## Données

Un projet = un dossier `<PROJECTS_DIR>/<uuid hex>/` contenant `project.sqlite` et `thumbs/<photo_id>.jpg`.
L'identifiant est vérifié (hexadécimal uniquement) avant tout accès disque.

Table `photo` : chemin absolu de la source, métadonnées originales (`*_orig`, `ts`, `heading_exif`…), colonnes de
correction prévues pour les phases suivantes (`lat`/`lon` corrigés, `heading_auto`, `heading_manual`,
`sequence_id`…). Les valeurs originales ne sont jamais réécrites.

- `ts` : heure de prise de vue de l'horloge caméra, stockée comme si elle était UTC (aucun fuseau dans les EXIF
  GoPro) ; seuls l'ordre et les écarts comptent. `gps_ts` : heure GPS (UTC réel).
- `idx` : rang chronologique (tri par `ts`, puis nom de fichier ; photos sans date à la fin).
- `flags` : masque d'anomalies (`db.py`) : sans GPS, sans date, doublon, coordonnées invalides, saut GPS,
  interruption avant la photo, illisible, même horodatage, fichier introuvable.
- `thumb` : 0 à faire, 1 faite, -1 échec (l'image est alors aussi marquée illisible).

## Flux d'import

`POST /api/projects/{id}/import {paths}` lance la tâche `import` :

1. scan récursif des `.jpg/.jpeg` (dossiers cachés ignorés), en sautant les chemins déjà importés ;
2. par lots de 250, en parallèle : ExifTool + hash rapide (sha1 de la taille et des premiers/derniers 64 Kio) ;
3. insertion, puis `analysis.run` (ordre + anomalies) ;
4. lancement de la tâche `thumbnails` (Pillow `draft()` : décodage JPEG réduit, rapide), dans l'ordre chronologique.
   La carte est utilisable dès la fin de l'étape 3.

Au redémarrage, les tâches restées « running » passent à « interrupted » et les miniatures manquantes sont relancées.

## Détection des sauts GPS

`analysis.detect` parcourt les photos géolocalisées en gardant une position de référence. Un déplacement est anormal
si la distance dépasse `jump_min_m` **et** la vitesse implicite `jump_speed_ms` (pas après une interruption).
Si la photo suivante est cohérente avec la référence, c'est un saut isolé : la référence n'est pas mise à jour.
Sinon c'est un décalage durable : la photo est signalée une fois et devient la référence.
Seuils modifiables par projet (`PATCH /api/projects/{id}` `{"settings": {...}}`).

## Pièges connus

- ExifTool doit être installé (`libimage-exiftool-perl`) ; chemin modifiable via `PSS_EXIFTOOL`.
- Fichier JPEG tronqué : ExifTool lit souvent l'en-tête sans erreur ; c'est la génération de la miniature qui le
  détecte.
- `setStyle` de MapLibre doit être appelé avec `{diff: false}`, sinon `style.load` ne se déclenche pas et les
  couches de photos ne sont pas recréées après un changement de fond.
- Panoramax (voir `ETUDE_PHASE1.md` §2.4) : ne jamais envoyer `relative_heading`, et un cap arrondi à 0 est recalculé
  par le serveur.

## Tests

`backend/tests` (pytest) : géodésie, analyse, lecture EXIF, import complet via l'API (bilan attendu, persistance
après redémarrage, originaux inchangés par comparaison de hash), fichiers introuvables, suppression de projet.

Mesures (4 cœurs, photos 1024×512 simulées) : import de 5 002 photos en 7,7 s (EXIF + analyse), 12 s avec les
miniatures ; ré-analyse 0,05 s. À refaire sur de vraies photos GoPro MAX (5,6K, ~5 Mo).
