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
  undo.py          annuler/rétablir générique (journal op_log : lignes modifiées avant/après)
  routes_edit.py   routes séquences, caps, annuler/rétablir, export
  exporter.py      export : un dossier par séquence, copies + EXIF, vérification par relecture
  exif/reader.py   lecture ExifTool (-json -n -fast, lots de 250 fichiers), dump complet pour inspection
  exif/writer.py   écriture ExifTool sur les copies (cap, position), règle « cap 0 » Panoramax
  core/geo.py      géodésie WGS84 (pyproj.Geod) : distance, azimut, longueur de trace
  core/analysis.py ordre chronologique, détection d'anomalies, bilan d'import
  core/headings.py calcul du cap, cap final, statistiques
  core/sequences.py création, limites, division, fusion, retrait, découpage proposé, statistiques
frontend/src/
  main.tsx         routage (#/p/<id>), thème clair/sombre/auto
  ProjectList.tsx  création, ouverture, suppression (avec confirmation) des projets
  ProjectView.tsx  barre d'outils, carte + timeline, onglets (Photo, Séquences, Export, Bilan), raccourcis clavier
  PhotoMap.tsx     MapLibre : une source GeoJSON (points colorés par séquence + trace), flèches de cap (SDF), plage, sélection
  Timeline.tsx     bande chronologique (canvas) : couleur par séquence, anomalies, interruptions, sélection de plage
  HeadingDial.tsx  cadran de cap (glisser, Maj = pas de 5°)
  SequencesTab.tsx plage, découpage proposé, liste des séquences et actions
  ExportTab.tsx    export par séquence, historique
  FolderPicker.tsx choix d'un dossier local
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

## Séquences et annuler/rétablir

Une photo appartient à au plus une séquence (`photo.sequence_id`, `rank` = rang dans la séquence, dans l'ordre de
`idx`). Les photos sans GPS, sans date, en doublon, illisibles ou introuvables ne peuvent pas être classées
(`sequences.EXCLUDED`). Une plage qui chevauche une autre séquence est refusée ; seules des séquences voisines
peuvent être fusionnées.

Toute modification passe par `undo.undoable(conn, libellé)` : les colonnes éditables de `photo`
(`undo.PHOTO_COLS`) et la table `sequence` sont capturées avant/après, seules les lignes modifiées sont journalisées
dans `op_log` (200 opérations gardées). Une nouvelle modification efface la pile « rétablir ». Les caps calculés sont
dérivés : ils sont recalculés après annuler/rétablir. **Toute nouvelle colonne éditable doit être ajoutée à
`PHOTO_COLS`.**

## Cap

`headings.compute` : pour chaque photo, azimut vers le premier point suivant à au moins `heading_min_m` (15 m par
défaut), cherché dans `heading_window_s` (12 s), sans traverser une interruption ; en fin de parcours, direction
d'arrivée. Points inutilisables (saut GPS, sans GPS, doublon…) : `missing` ; arrêt (aucun point assez loin) :
`uncertain` — jamais de valeur inventée.

Cap final = `heading_manual` s'il existe, sinon `(heading_auto + sequence.heading_offset) mod 360`
(`headings.FINAL_SQL`, `final_heading`). Attention : le `%` de SQLite travaille sur des entiers, d'où la
normalisation explicite dans `FINAL_SQL`.

Choix de 15 m : mesuré sur une sortie simulée de 5 000 photos (bruit GPS ~2 m, retard 0,5–3 s, virages serrés) par
rapport à la vraie direction : erreur médiane 7,2° / 90e centile 29° avec 5 m, 3,9° / 15,8° avec 15 m, 3,4° / 14,5°
avec 20 m mais 16 photos incertaines. À revalider sur de vraies photos.

## Export

`exporter.run` : vérifie d'abord que chaque dossier cible est absent, vide, ou un export précédent du même projet
(marqueur `.pss-export.json`, dont seuls les fichiers listés sont supprimés) ; refuse un dossier d'export situé dans
un dossier source (les copies seraient ré-importées). Puis par lots de 200 en parallèle : copie
(`.tmp` puis renommage), écriture ExifTool (`writer.write_batch`, un seul processus par lot avec `-execute`),
relecture et comparaison des valeurs. Le test `test_export.py` vérifie aussi que les données image (après le
marqueur SOS) sont identiques à l'original : pas de recompression.

Règle Panoramax (option, activée par défaut) : un cap qui s'arrondit à 0° est écrit 0,6°, car Panoramax arrondit à
l'entier et recalcule les caps nuls.

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
- Dans les filtres MapLibre, `null` n'est pas utilisable : une photo sans cap a `heading = -1` dans le GeoJSON.
- `setStyle` de MapLibre doit être appelé avec `{diff: false}`, sinon `style.load` ne se déclenche pas et les
  couches de photos ne sont pas recréées après un changement de fond.
- Panoramax (voir `ETUDE_PHASE1.md` §2.4) : ne jamais envoyer `relative_heading`, et un cap arrondi à 0 est recalculé
  par le serveur.

## Tests

`backend/tests` (pytest, 34 tests) : géodésie, analyse, lecture EXIF, import complet via l'API (bilan attendu,
persistance après redémarrage, originaux inchangés par comparaison de hash), fichiers introuvables, suppression de
projet ; calcul du cap (lignes droites, passage 359°/0°, arrêts, interruptions, précision sur sortie simulée) ;
séquences et annuler/rétablir ; export (dossiers, EXIF relus, données image identiques, métadonnées GoPro/GPano
conservées, ré-export, dossier étranger refusé).

Mesures (4 cœurs, photos 1024×512 simulées) : import de 5 002 photos en 7,7 s (EXIF + analyse), 12 s avec les
miniatures ; ré-analyse 0,05 s ; export de 4 955 photos (2 séquences, copie + EXIF + relecture) en 19 s. À refaire sur de vraies photos GoPro MAX (5,6K, ~5 Mo).
