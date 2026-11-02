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
  exporter.py      export (copie / déplacement des sources / sur place), vérification par relecture, restauration des sources
  exif/reader.py   lecture ExifTool (-json -n -fast, lots de 250 fichiers), dump complet pour inspection
  exif/writer.py   écriture ExifTool (cap, position), lecture/restauration des balises d'origine, règle « cap 0 » Panoramax
  core/geo.py      géodésie WGS84 (pyproj.Geod) : distance, azimut, longueur de trace
  core/analysis.py ordre chronologique, détection d'anomalies, bilan d'import
  core/headings.py calcul du cap, cap final, statistiques
  core/sequences.py création, limites, division, fusion, retrait, découpage proposé, statistiques
  core/positions.py corrections de position : saisie, décalage, le long du trajet, retour à l'original
  core/timesync.py  retard GPS : trace, position à un instant, projection d'un point sur la trace, application
frontend/src/
  main.tsx         routage (#/p/<id>), thème clair/sombre/auto
  ProjectList.tsx  création, ouverture, suppression (avec confirmation) des projets
  ProjectView.tsx  barre d'outils, carte + timeline, onglets (Photo, Séquences, Export, Bilan), raccourcis clavier
  PhotoMap.tsx     MapLibre : une source GeoJSON (points colorés par séquence + trace), flèches de cap (SDF), plage, sélection
  Timeline.tsx     bande chronologique (canvas) : couleur par séquence, anomalies, interruptions, sélection de plage
  HeadingDial.tsx  cadran de cap (glisser, Maj = pas de 5°)
  Viewer360.tsx    visionneuse 360° (Photo Sphere Viewer 5) : miniature puis original, direction de vue conservée
                   d'une photo à l'autre, bascule « à plat », bouton « Fixer la direction du vélo »
  SequencesTab.tsx plage, découpage proposé, liste des séquences et actions
  ExportTab.tsx    export par séquence, historique
  FolderPicker.tsx choix d'un dossier local
  SyncTab.tsx      onglet Synchro : visionneuse, décalage en direct, points de calage, application
  PhotoViewer.tsx  visionneuse plate pleine définition (molette = zoom, glisser = déplacer)
  timesync.ts      miroir JS de core/timesync.py pour l'aperçu en direct (positionAt, snap)
  ImportDialog.tsx sélecteur de dossiers (via /api/fs)
  basemaps.ts      fonds de carte (OSM, Esri World Imagery, OpenTopoMap, XYZ personnalisés)
tools/make_samples.py  générateur de sorties GoPro MAX simulées + vérité terrain
```

## Docker

`Dockerfile` en deux étapes : construction de l'interface (`node:22`), puis exécution sur `ubuntu:24.04` (Python 3.12
dans `/opt/venv`, ExifTool 12.76 du paquet `libimage-exiftool-perl`, la version utilisée par les tests). Variables :
`PSS_DATA_DIR=/data`, `PSS_DEFAULT_DIR=/photos` (dossier ouvert par défaut par les sélecteurs de dossiers, via
`config.DEFAULT_DIR`). `docker-compose.yml` : utilisateur `PUID:PGID`, port publié sur `127.0.0.1` seulement,
volumes `/data`, `/photos`, `/exports`, contrôle de santé sur `/api/projects`. `config.ensure_dirs` vérifie le droit
d'écriture dans `/data` et s'arrête avec un message explicite sinon.

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

`headings.compute` : pour chaque photo, azimut vers le premier point suivant à au moins `heading_min_m` (3 m par
défaut), cherché dans `heading_window_s` (12 s), sans traverser une interruption ; en fin de parcours, direction
d'arrivée. Points inutilisables (saut GPS, sans GPS, doublon…) : `missing` ; arrêt (aucun point assez loin) :
`uncertain` — jamais de valeur inventée.

Cap final = `heading_manual` s'il existe, sinon `(heading_auto + sequence.heading_offset) mod 360`
(`headings.FINAL_SQL`, `final_heading`). Attention : le `%` de SQLite travaille sur des entiers, d'où la
normalisation explicite dans `FINAL_SQL`.

Choix de 3 m (par défaut) : la référence est le point suivant (cahier des charges) ; le seuil ne sert qu'à sauter les
points quasi confondus (arrêt). Un seuil de 15 m avait été retenu d'après une sortie simulée très bruitée (bruit GPS
~2 m pour 10 m entre photos), mais sur de vraies photos plus rapprochées il prenait comme référence un point 2 ou 3
photos plus loin et les flèches coupaient les virages. Mesures sur la sortie simulée : erreur médiane
7,2° / 90e centile 29° avec 5 m, 3,9° / 15,8° avec 15 m, 3,4° / 14,5°
avec 20 m mais 16 photos incertaines. À revalider sur de vraies photos.

## Positions

`photo.lat_orig/lon_orig` ne changent jamais ; la position corrigée est dans `photo.lat/lon` (NULL = originale) avec
`pos_method` (`manual`, `offset`, `along`). Une photo corrigée n'est plus considérée comme « sans GPS / saut / invalide »
pour le cap, les séquences et l'export : `db.EFF_FLAGS_SQL` / `db.eff_flags` effacent ces drapeaux quand `lat` est
renseignée (le bilan d'import garde les anomalies d'origine). Après une correction, les caps sont recalculés et les
caps manuels voisins (±3 photos) marqués `heading_stale` (« à revoir »), jamais écrasés.

Interface : mode `M` → marqueur MapLibre déplaçable sur la photo courante (`dragend` → `PUT …/position`) ; clic sur la
carte pour placer une photo sans position ; couches `moves-*` : position d'origine et lien vers la corrigée.

## Exclusion, découpe en un geste

`photo.excluded` (annulable) : la photo sort de sa séquence et ne peut plus y entrer (`sequences._eligible`) ; elle
reste un point de la trace GPS (cap, synchronisation). Réintégrée entre deux photos d'une même séquence, elle y
revient. `exporter.trash_excluded` déplace les fichiers exclus dans `<dossier>/_exclues/` en renseignant
`moved_from` : `restore_sources` les remet. `sequences.cut_at` (touche C) : coupe la séquence de la photo, ou, pour
une photo non classée, crée la séquence sur le bloc non classé qui l'entoure puis la coupe.
`create_from_unclassified` : une séquence par bloc non classé. Les séquences au nom par défaut « Séquence N » sont
renumérotées dans l'ordre de la sortie après chaque opération (`renumber_default_names`).

## Caméra sur casque : lacet

`photo.yaw_offset` = angle du centre de l'image par rapport à la direction du vélo (degrés, droite > 0, annulable).
C'est la valeur écrite dans `XMP-GPano:PoseHeadingDegrees`, que Panoramax lit comme le lacet (« front = 0°,
right = 90° ») et que Photo Sphere Viewer applique comme correction de sphère (`pan = PoseHeadingDegrees`) : avec
30°, l'avant de la vue montre ce qui est à 30° à gauche du centre de l'image (vérifié dans le navigateur).
`GPSImgDirection` reste la direction du vélo. Fixer : la vue est dans le repère corrigé, donc si l'on regarde la
route à l'angle `y`, le nouveau lacet vaut `lacet_actuel − y`. La visionneuse impose ce lacet (fournisseur
`panoData`) au lieu de lire le XMP du fichier. Sans lacet fixé, l'export ne touche pas la balise, sauf pour remettre
la valeur d'origine d'une source déjà modifiée.

## Retard GPS (synchronisation temporelle)

`core/timesync.py`. La *trace* = positions GPS d'origine des photos fiables (ni saut, ni doublon, ni sans date),
triées par temps, coupées aux interruptions (`GAP_BEFORE`) ; deux points de même horodatage : seul le premier est
gardé. `position_at(track, t)` interpole (géodésique) entre les deux points encadrant `t` — la photo reste sur
l'itinéraire — et extrapole au plus `MAX_EXTRAPOLATION_S` (5 s) au-delà d'une extrémité ; dans une interruption :
`None` (photo laissée telle quelle, comptée « hors trace »).

Mesure : `offset_for_point` projette le point lâché par l'utilisateur sur les segments de la trace situés à ±30 s
de la photo (pour ne pas s'accrocher à un autre passage dans la même rue) ; décalage = instant du point projeté −
instant de la photo. Le navigateur fait la même projection (`timesync.ts`, projection plane locale) pour l'aperçu
pendant le glisser, puis demande la valeur au backend au relâchement.

Application (`apply`) : `lat/lon` = position de la trace à `ts + décalage`, `pos_method = 'time'`,
`photo.time_offset` = décalage. Les positions `manual` / `offset` / `along` sont gardées si `keep_manual`.
`time_offset` fait partie des colonnes annulables (`undo.PHOTO_COLS`). Points de calage et dernier décalage
appliqué : `meta.sync_points`, `meta.last_time_offset`.

Mesure sur la sortie simulée de 300 photos (retard 0,5–3 s, bruit ~2 m, épisodes de décalage latéral de 12 m) :
un point de calage glissé sur la vraie position donne +1,6 s (retard réel 1,46 s) ; erreur médiane de position
5,8 m → 2,2 m, 90e centile 9,8 → 6,0 m. Une photo prise dans un épisode de décalage latéral donne un décalage faux
(−0,8 s) : d'où le conseil de caler là où la trace suit la route, et de comparer plusieurs points.

## Photos GoPro MAX réelles : balises

Comparaison d'une photo brute et d'une photo acceptée par Panoramax (fournies par l'utilisateur, firmware
H19.03.02.06.00, 5760×2880) :

- brute : `DateTimeOriginal` sans sous-secondes, GPS (position, altitude, `GPSTimeStamp`/`GPSDateStamp`) **sans**
  `GPSVersionID` ni `GPSImgDirection`, XMP-GPano complet avec `Pose{Heading,Pitch,Roll}Degrees = 0.0`, bloc GoPro
  (GPMF : `GoPro_GRAV`, `GoPro_CORI`…), MPF avec image d'aperçu ;
- corrigée : en plus `GPSVersionID 2 3 0 0`, `GPSSpeed`/`GPSSpeedRef K`, `GPSImgDirection`/`GPSImgDirectionRef T` ;
  `PoseHeadingDegrees` reste 0.0.

L'export écrit donc `GPSImgDirection`/`Ref`, `GPSSpeed`/`Ref` (`exporter.speeds_kmh` : voisins à ≤ 10 s, valeurs
> 150 km/h ignorées), `GPSVersionID`, et la position corrigée ; `PoseHeadingDegrees` seulement si un angle de tête a
été fixé (voir « Caméra sur casque ») ; jamais le tangage/roulis (Panoramax redresse l'horizon lui-même). Une photo source modifiée par une version antérieure (qui
écrivait le cap dans `PoseHeadingDegrees`) récupère la valeur d'origine sauvegardée dans `orig_tags`.

Heures : l'horloge de la caméra (`DateTimeOriginal`, heure locale) avait ~12 à 15 min d'avance sur l'heure GPS (UTC)
sur ces deux photos, et n'était pas passée à l'heure d'hiver. L'application ordonne et synchronise avec l'horloge
caméra (seuls les écarts comptent). Panoramax, lui, retient l'heure GPS quand l'heure caméra n'a pas de
sous-secondes (`TimeBySource.getBest`) : c'est l'heure GPS qui sera affichée.

## Export

Modes (`exporter.MODES`) : `copy` (copies), `move` (les sources sont déplacées dans les dossiers de séquence et
modifiées), `in_place` (sources modifiées sans déplacement, pas de dossier). Pour `move`/`in_place` : avant la
première écriture, `writer.read_tags` sauvegarde dans `photo.orig_tags` les valeurs des balises que l'application
écrit (`writer.WRITTEN_TAGS`) ; `photo.moved_from` garde le tout premier chemin ; les déplacements passent par des noms
temporaires (renumérotation sans écrasement) et `photo.path` est mis à jour à chaque renommage. ExifTool écrit les
sources avec `-overwrite_original_in_place -P` (date du fichier conservée). `restore_sources` réécrit les valeurs
sauvegardées (une balise absente à l'origine est supprimée), vérifie par relecture, puis remet les fichiers en place.
Un ré-export `move` ne supprime jamais un fichier qui est une photo du projet. Les positions restaurées sont
réencodées depuis la valeur décimale : identiques à ~1e-9° près, pas au bit près.

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
- Dans une expression MapLibre, `zoom` doit être au premier niveau (`interpolate`/`step`) : `['case', …, ['interpolate', …, ['zoom'] …]]`
  est refusé et la couche n'est pas créée.
- Dans les filtres MapLibre, `null` n'est pas utilisable : une photo sans cap a `heading = -1` dans le GeoJSON.
- `setStyle` de MapLibre doit être appelé avec `{diff: false}`, sinon `style.load` ne se déclenche pas et les
  couches de photos ne sont pas recréées après un changement de fond.
- Panoramax (voir `ETUDE_PHASE1.md` §2.4) : ne jamais envoyer `relative_heading`, et un cap arrondi à 0 est recalculé
  par le serveur.

## Tests

`backend/tests` (pytest, 51 tests) : géodésie, analyse, lecture EXIF, import complet via l'API (bilan attendu,
persistance après redémarrage, originaux inchangés par comparaison de hash), fichiers introuvables, suppression de
projet ; calcul du cap (lignes droites, passage 359°/0°, arrêts, interruptions, précision sur sortie simulée) ;
séquences et annuler/rétablir ; export (dossiers, EXIF relus, données image identiques, métadonnées GoPro/GPano
conservées, ré-export, dossier étranger refusé) ; positions (saisie, annuler, décalage, le long du trajet, saut
corrigé utilisable, cap manuel « à revoir ») ; modification des sources sur place et par déplacement, puis
restauration (balises d'origine, emplacement, données image identiques) ; synchronisation (interpolation sur la
trace, virage, extrapolation limitée, projection d'un point, gain de précision sur sortie simulée, portée, positions
manuelles gardées).

Mesures (4 cœurs, photos 1024×512 simulées) : import de 5 002 photos en 7,7 s (EXIF + analyse), 12 s avec les
miniatures ; ré-analyse 0,05 s ; export de 4 955 photos (2 séquences, copie + EXIF + relecture) en 19 s. À refaire sur de vraies photos GoPro MAX (5,6K, ~5 Mo).
