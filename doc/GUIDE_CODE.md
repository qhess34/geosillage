# Guide du code

Fonctionnement interne. Pour commencer : [DEVELOPPEMENT.md](DEVELOPPEMENT.md) (installation, vérifications,
recettes) et [AGENTS.md](../AGENTS.md) (règles).

**Sommaire** : [Vue d'ensemble](#vue-densemble) · [Docker](#docker) · [Données](#données) · [Flux d'import](#flux-dimport) · [Séquences et annuler/rétablir](#séquences-et-annulerrétablir) · [Cap](#cap) · [Recalage sur les voies OpenStreetMap](#recalage-sur-les-voies-openstreetmap) · [Trace GPX](#trace-gpx) · [Positions](#positions) · [Exclusion, découpe en un geste](#exclusion-découpe-en-un-geste) · [Création manuelle, visionneuse et carte](#création-manuelle-visionneuse-et-carte) · [Orientation (caméra sur casque, caméra à l'envers)](#orientation-caméra-sur-casque-caméra-à-lenvers) · [Retard GPS (synchronisation temporelle)](#retard-gps-synchronisation-temporelle) · [Photos GoPro MAX réelles : balises](#photos-gopro-max-réelles--balises) · [Surcouche Panoramax](#surcouche-panoramax) · [Publication Panoramax](#publication-panoramax) · [Séquences déjà publiées (corrections)](#séquences-déjà-publiées-corrections) · [Projets Panoramax (séquences déjà publiées)](#projets-panoramax-séquences-déjà-publiées) · [Réexport](#réexport) · [Export](#export) · [Détection des sauts GPS](#détection-des-sauts-gps) · [Barre d'étapes](#barre-détapes) · [Confort de l'interface](#confort-de-linterface) · [Points à vérifier (contrôle qualité)](#points-à-vérifier-contrôle-qualité) · [Pièges connus](#pièges-connus) · [Tests](#tests)

## Vue d'ensemble

Un seul processus local : FastAPI (`backend/app/main.py`) sert l'API REST sous `/api` et l'interface construite
(`frontend/dist`). Écoute sur `127.0.0.1` uniquement : l'API donne accès au système de fichiers local.

Fichiers et modules : voir la carte « Où modifier quoi » d'[AGENTS.md](../AGENTS.md). Pour les fichiers absents de
cette carte :

- `backend/app/config.py` : chemins, nombre de workers, seuils d'analyse par défaut
- `db.py` : base SQLite par projet, migrations (PRAGMA user_version), drapeaux d'anomalies
- `jobs.py` : tâches de fond (un thread par tâche, état persistant dans la table `job`)
- `importer.py` : scan récursif, hash rapide, lecture EXIF par lots, analyse, miniatures, fichiers introuvables
- `undo.py` : annuler/rétablir générique (journal `op_log` : lignes modifiées avant/après)
- `exif/reader.py` : lecture ExifTool (`-json -n -fast`, lots de 250 fichiers), dump complet pour inspection
- `exif/writer.py` : écriture ExifTool (cap, position), lecture/restauration des balises d'origine, règle « cap 0 » Panoramax
- `core/geo.py` : géodésie WGS84 (pyproj.Geod) : distance, azimut, longueur de trace
- `frontend/src/main.tsx` : routage (`#/p/<id>`), thème clair/sombre/auto
- `ProjectList.tsx` : création, ouverture, suppression (avec confirmation) des projets ; `StepBar.tsx` : barre d'étapes
- `FolderPicker.tsx` : choix d'un dossier local ; `PhotoViewer.tsx` : visionneuse plate pleine définition
- `timesync.ts` : miroir JS de `core/timesync.py` pour l'aperçu en direct (positionAt, snap)
- `tools/make_samples.py` : générateur de sorties GoPro MAX simulées + vérité terrain

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

Cap final = `heading_manual` s'il existe, sinon `(heading_auto + photo.heading_offset) mod 360`. Le décalage est
porté par chaque photo (`POST …/headings/offset` : toute la sortie ou une plage d'index), jamais par une séquence
(simple découpage) ; la migration a reporté les anciens décalages de séquence sur leurs photos (`sequence.heading_offset`
reste à 0, inutilisé)
(`headings.FINAL_SQL`, `final_heading`). Attention : le `%` de SQLite travaille sur des entiers, d'où la
normalisation explicite dans `FINAL_SQL`.

Choix de 3 m (par défaut) : la référence est le point suivant (cahier des charges) ; le seuil ne sert qu'à sauter les
points quasi confondus (arrêt). Un seuil de 15 m avait été retenu d'après une sortie simulée très bruitée (bruit GPS
~2 m pour 10 m entre photos), mais sur de vraies photos plus rapprochées il prenait comme référence un point 2 ou 3
photos plus loin et les flèches coupaient les virages. Mesures sur la sortie simulée : erreur médiane
7,2° / 90e centile 29° avec 5 m, 3,9° / 15,8° avec 15 m, 3,4° / 14,5°
avec 20 m mais 16 photos incertaines. À revalider sur de vraies photos.

Arrêt (aucun point assez loin dans la fenêtre, ni devant ni derrière) : la photo prend la **direction d'arrivée** à
l'arrêt (dernier point à plus du seuil avant elle, sans limite de temps, dans le même tronçon), sinon celle de départ ;
état `stop`. Sans cela, la photo gardée d'un arrêt (les autres exclues) n'avait pas de cap. Seul un tronçon où la
caméra ne bouge jamais reste `uncertain`.

## Recalage sur les voies OpenStreetMap

`core/osm.py`. **Données** : `fetch_ways` interroge Overpass (`PSS_OVERPASS_URL`, défaut overpass-api.de) sur
l'emprise des photos + 50 m, arrondie vers l'extérieur à 0,002° (`bbox_of`), **toutes** les voies `highway` (gravel / VTT : n'importe quel chemin ; à pied, en voiture), sauf celles qu'on
ne parcourt pas (`NOT_TRAVELLED` : en projet, disparues, quais, ascenseurs, couloirs, aires de service) ; la clé du
cache porte `CACHE_VERSION`, à changer avec la requête, géométrie et nœuds (`out geom tags`) ; réponse gardée dans la table `osm_cache` du projet (clé =
emprise). Overpass refuse les clients anonymes (406) : `User-Agent` avec lien de contact et `Accept` obligatoires ;
3 essais. **Appariement** (`match`, calcul pur sur une projection plane locale) : voies à moins de `max_dist`
(15 m) de chaque photo ; suite de voies la plus probable par Viterbi (coût = distance + changement de voie :
4 m si les deux voies ont un nœud commun, 25 m sinon) ; tronçons de photos consécutives sur la même voie, statut
`clear`, `ambiguous` (autre voie à moins de 3 m en distance moyenne sur le tronçon : liste des candidates) ou
`none`. Renvoie aussi, pour chaque photo, sa projection sur chaque voie candidate (aperçu dans l'interface).
**Routes** : `POST …/osm/snap/propose` (rien n'est modifié ; `manual_ids` : photos placées à la main) et
`POST …/osm/snap/apply` (segments choisis → projection, `pos_method = 'osm'`, une opération annulable ; photos
`manual` épargnées si `keep_manual`). **Interface** : `OsmSnapPanel.tsx` (au-dessus de l'onglet Photo, amené à
l'écran à l'ouverture ; ouvert par le menu contextuel `ContextMenu.tsx` : clic droit sur la carte (`PhotoMap.onContextMenu`), la
timeline (`Timeline.onContextMenu`) ou une séquence (`SequencesTab.onSeqContext`) ; `photosContext` prend la
sélection si la photo cliquée en fait partie, sinon la photo ; le menu propose aussi « Créer une séquence » si
aucune photo choisie n'est classée, hors projet Panoramax). Portée propre au panneau, **indépendante du découpage** (`seqStart` jamais utilisé) : `sequence` (séquence
de la photo à l'ouverture), `timeline` (plage tracée, seulement si aucun début n'est posé), `custom` (bornes « de
cette photo / jusqu'à cette photo », ou `D` / `F` interceptés par la fenêtre en phase de capture tant
qu'elle est ouverte : la fin suit ← → après `D`, proposition recalculée 0,5 s après la dernière touche) ; la portée est surlignée sur la carte et la timeline (`snapHighlight`, couches `range` + `range-ring` de la carte). Le panneau est une fenêtre flottante dans la zone
carte (`.snap-modal`, déplaçable par sa barre de titre, `Échap` la ferme) : la carte et la navigation restent
utilisables. **Timeline** : fenêtre visible `[start, start + span)` (zoom molette autour du curseur ou − / + / Tout,
au plus 20 photos ; défilement par la barre, Maj+molette ou glissement horizontal ; la photo courante est ramenée
dans la fenêtre ; écouteur `wheel` non passif) ; aperçu `snapPreview` de `PhotoMap` (couches `snap-ways`, `snap-hl` =
voie survolée, `snap-moves`, `snap-new`). Tests : `test_osm.py` (voie unique, voies parallèles, carrefour, rien à
proximité, API avec réponse Overpass simulée, Overpass injoignable → 502).

## Trace GPX

`core/gpx.py`. `parse` : points horodatés des `trkseg` (les `rte` sans heure sont refusés), coupés aux trous de plus
de max(30 s, `gap_seconds`). Stockée dans `meta.gpx` (`runs` en UTC, `shift_s`, `shift_from`) ; `meta.track_source` =
`gpx` ou `camera`. **Horloges** : les photos sont en heure locale de la caméra stockée comme UTC (`exif.reader`), le
GPX en UTC vrai : `shift_s` = heure des photos − UTC, détecté à l'import (`detect_shift`) : d'abord le décalage, au
quart d'heure près sur ±14 h, qui rapproche le plus le GPX des positions d'origine de la caméra (médiane < 200 m),
sinon la médiane de `ts − gps_ts` ; modifiable (`PATCH …/gpx`). `track` = runs dans l'heure des photos ;
`timesync.build_track` le renvoie quand la source est `gpx` (synchro, glisser, aperçu inchangés), sinon
`build_camera_track`. **Projection** (`snap`, `POST …/gpx/snap`) : point le plus proche de la ligne (`osm.Frame`,
`_project_xy`), seulement sur les morceaux du GPX proches des photos ; au-delà de `max_dist` la photo ne bouge pas ;
`pos_method='gpx'` (dans `MANUAL_METHODS`), une opération annulable. Interface : `Gpx.tsx` (`GpxSection` de l'onglet
Synchro, `GpxFilePicker` = `FsBrowser` avec `onFile` et `/api/fs?ext=.gpx`, `GpxSnapDialog`, fenêtre flottante sans fond : ligne
affichée par `PhotoMap.lineTrack`, aperçu `preview: true` → `moves` dans `snapPreview`). Tests : `test_gpx.py`.

## Positions

`photo.lat_orig/lon_orig` ne changent jamais ; la position corrigée est dans `photo.lat/lon` (NULL = originale) avec
`pos_method` (`manual`, `offset`, `along`). Une photo corrigée n'est plus considérée comme « sans GPS / saut / invalide »
pour le cap, les séquences et l'export : `db.EFF_FLAGS_SQL` / `db.eff_flags` effacent ces drapeaux quand `lat` est
renseignée (le bilan d'import garde les anomalies d'origine). Après une correction, les caps sont recalculés et les
caps manuels voisins (±3 photos) marqués `heading_stale` (« à revoir »), jamais écrasés.

Photos sans position : `positions.missing_runs` (blocs de photos utilisables sans position effective, avec les
photos positionnées avant/après ; `GET …/positions/missing`), `positions.interpolate` (`POST …/positions/batch`
mode `interpolate` : position sur le segment avant→après au prorata de `ts`, ou du rang sans heure ;
`pos_method = 'interp'`), `positions.attach_to_sequences` (après toute pose de position — saisie, interpolation,
synchro — une photo non classée rejoint la séquence commune de ses voisines utilisables, en sautant les photos du
même lot). `positions.MANUAL_METHODS` (`manual`, `offset`, `along`, `interp`, `osm`) : positions gardées par la
synchro. Carte : `gapNeighbours` (photo courante sans position → voisines entourées, couche `gap-*`, cadrage).

Interface : mode `M` → marqueur MapLibre déplaçable sur la photo courante (`dragend` → `PUT …/position`) ; clic sur la
carte pour placer une photo sans position ; couches `moves-*` : position d'origine et lien vers la corrigée.

Report de la correction (`carryPos`, case « Reporter la correction (→) », visible en mode Positions,
`localStorage['pss-carry-position']`, cochée par défaut) : `lastCarry` retient, dès le `dragend`, le déplacement fait
à la main (est / nord en m entre la position avant le glisser, d'origine ou déjà corrigée — synchro comprise — et
le point lâché ; un nouveau glisser de la même photo s'ajoute) et la photo qui le porte. `→` (sans Maj) depuis
cette photo applique le même déplacement à la photo suivante non exclue (`POST …/positions/batch` mode `offset`, à
partir de sa position actuelle), sauf si elle a été corrigée à la main (`manual`), et la chaîne continue. `←`,
`Maj+→` et les clics ne reportent rien ; annuler / rétablir vide `lastCarry` ; chaque report s'annule avec
`Ctrl+Z`. Ne dépend pas du rechargement des photos (`→` juste après avoir lâché le point).

## Exclusion, découpe en un geste

`photo.excluded` (annulable) : la photo sort de sa séquence et ne peut plus y entrer (`sequences._eligible`) ; elle
reste un point de la trace GPS (cap, synchronisation). Réintégrée entre deux photos d'une même séquence, elle y
revient. `exporter.trash_excluded` déplace les fichiers exclus dans `<dossier>/_exclues/` en renseignant
`moved_from` : `restore_sources` les remet. `sequences.cut_at` (touche C) : coupe la séquence de la photo, ou, pour
une photo non classée, crée la séquence sur le bloc non classé qui l'entoure puis la coupe.
`create_from_unclassified` : une séquence par bloc non classé. Les séquences au nom par défaut « Séquence N » sont
renumérotées dans l'ordre de la sortie après chaque opération (`renumber_default_names`).

## Création manuelle, visionneuse et carte

`ProjectView` : `seqStart` = photo marquée « Début » ; tant qu'il est posé, la plage suit la photo courante ;
« Fin » crée la séquence `[début, photo courante]` (ou la plage tracée sur la timeline), puis pose `seqStart` sur
la photo suivante non exclue (`nextKept`) si elle n'est dans aucune séquence : on enchaîne les `F`. `X` sur la photo
de début déplace le début sur la suivante non exclue ; tant qu'un début est posé, `X` n'exclut que la photo
courante (pas la plage). Sans début posé, `X` sur une plage de plusieurs photos demande confirmation
(`window.confirm`, nombre de photos) : un clic un peu glissé sur la timeline sélectionnait des centaines de photos,
d'où aussi le seuil de glisser `DRAG_PX` (8 px) de `Timeline`. Photos exclues : `showExcluded` (case « Exclues » de la carte,
`localStorage['pss-show-excluded']`, décochée par défaut) ; décochée, la carte reçoit `mapPhotos` (sans les
exclues) et `stepIdx` fait sauter les exclues à ← →, Début/Fin et après `X` (la timeline les montre toujours en
creux et permet d'y aller). La visionneuse signale sa
direction (`onView`, événement `position-updated` de Photo Sphere Viewer) : la flèche de la photo sélectionnée sur
la carte prend l'orientation cap + direction de vue (`viewAzimuth`). Après un glisser, Photo Sphere Viewer continue
par inertie : « Fixer le sens de déplacement » appelle `stopAnimation()` avant de lire la direction. En mode
Positions ou Synchro, le zoom au double-clic de la carte est désactivé (sélectionner une photo puis saisir son
marqueur faisait un double-clic) ; la carte ne se recentre que lorsque la photo sélectionnée change.

## Orientation (caméra sur casque, caméra à l'envers)

`photo.yaw_offset` = lacet Panoramax, écrit dans `XMP-GPano:PoseHeadingDegrees` (modulo 360). Convention du viewer
Panoramax (repris de [pan360-fixexif](https://github.com/qhess34/pan360-fixexif), copie de `getSphereCorrection()`
de `@panoramax/web-viewer`) : `sphereCorrection = {pan: yaw, tilt: -pitch, roll: roll}`, et le XMP de l'image est
ignoré. Avec `pan = +30°`, l'avant de la vue montre l'image à +30° de son centre (vérifié dans le navigateur ; la
« pose » GPano de Photo Sphere Viewer tourne dans l'autre sens, ce qu'utilisait la visionneuse avant : la migration
n° 7 a inversé le signe des valeurs déjà fixées, ±180° inchangé).

**Le viewer Panoramax n'applique l'orientation d'une photo 360° que si le tangage ET le roulis sont non nuls.** La
GoPro écrit `PosePitchDegrees = PoseRollDegrees = 0.0` : à l'export, quand une orientation non nulle est écrite, un
0 (ou une balise absente) devient `writer.NUDGE` = 0,01° (invisible), comme dans pan360-fixexif. Sans orientation,
ces balises ne sont pas touchées (ou reprennent leur valeur d'origine sur une source déjà modifiée ; `orig_tags`
contient `_captured`, la liste des balises sauvegardées, pour ne pas effacer celles que les anciennes versions ne
sauvegardaient pas).

Visionneuse : `sphereCorrection` = orientation de la photo, pose XMP forcée à 0. « Fixer le sens de déplacement » :
la vue est dans le repère corrigé ; si l'on regarde la route à l'angle `y`, la nouvelle orientation vaut
`orientation + y`. `GPSImgDirection` reste le sens de déplacement (le viewer Panoramax ouvre la photo en comparant
ce cap à la direction vers la photo précédente). `POST …/headings/yaw` : `yaw` (valeur fixée) ou `add` (ajoutée à
chaque photo : caméra à l'envers = 180°), sur des photos, une plage, une séquence (`sequence_id`) ou tout le projet
(`all`). Interface : `YawRotate.tsx` (correction du montage de la caméra sur le casque : angle libre,
`localStorage['pss-yaw-angle']`, « ↻ Corriger le montage » = `add`, jamais `yaw` qui effacerait les angles de tête)
pour une séquence, tout le projet et la plage de l'onglet Photo.

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

Aperçu : `SyncTab` calcule les photos que la portée choisie déplacerait (sans les corrections à la main si elles
sont gardées, comme `positions.MANUAL_METHODS`) et les passe à la carte (`sync.ids`) ; seules ces photos ont un
point orange.

Lots (`timesync.runs`, `GET …/timesync/runs`) : photos consécutives (non exclues, utilisables) de même
`time_offset` arrondi au dixième (`pos_method = 'time'`), sinon « non synchronisées » ; les photos corrigées à la
main (`MANUAL_METHODS`) ne coupent pas un lot, elles y sont comptées (`manual`). Affiché dans l'onglet *Synchro*.

Portées de `POST …/timesync/apply` : `all`, `sequence`, `range`, `from` (photos `idx >= start_idx` : retard
variable au cours d'une sortie, les photos d'avant ne sont pas touchées donc pas marquées « à réexporter »).
`SyncTab` propose `all` tant qu'aucune synchro n'a été appliquée (`last_time_offset`), puis `from` ; la médiane
des points de calage est calculée sur les points de la portée. Application (`apply`) : `lat/lon` = position de la trace à `ts + décalage`, `pos_method = 'time'`,
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

## Surcouche Panoramax

`frontend/src/panoramaxLayer.ts` : source vectorielle `{instance}/api/map/{z}/{x}/{y}.mvt` (tuiles publiques de
l'API Panoramax, lues directement par le navigateur ; documentées dans `geovisio/web/map.py`) : couche `sequences`
(zoom ≥ 7 : `date` AAAA-MM-JJ, `type`, `model`) et `pictures` (zoom ≥ 15 : `ts`, `heading`, `type`, `model`).
Source par défaut : le méta-catalogue fédéré `https://api.panoramax.xyz` (toutes les instances référencées, comme
panoramax.fr ; mêmes tuiles qu'une instance), ou une instance au choix (`PANORAMAX_PRESETS`, adresse libre) ;
l'ancien défaut enregistré (panoramax.openstreetmap.fr, sans marqueur `v`) bascule sur le méta-catalogue.
Seules les photos `equirectangular` sont affichées (un objet sans `type` est gardé) ; couleur selon l'âge par comparaison de chaînes ISO
(`>=` sur la date d'il y a 1 et 3 ans). Couches ajoutées sous celles du projet, infobulle au survol (texte inséré
avec `textContent`) : date, appareil et auteur. Les tuiles ne donnent que des identifiants (`id`, `account_id`,
`first_sequence` / `sequences`) : `authorOf` cherche le nom au survol, dans l'ordre, dans le fournisseur
« producer » de la séquence (`GET /api/collections/{id}`, `providers`), dans la photo
(`GET /api/search?ids=…`, `geovisio:producer`), puis le compte (`GET /api/users/{account_id}`, `name`) ; résultat
mis en cache par session (« inconnu » si rien ne répond). Réglages (affichage, instance) dans le stockage local du navigateur. Vérifié sur le
méta-catalogue réel (`api.panoramax.xyz`, novembre 2026) : tuiles servies jusqu'au zoom 15 (au-delà : erreur 400,
d'où `maxzoom: 15` de la source, MapLibre agrandit les tuiles 15), mêmes couches et propriétés qu'une instance,
`GET /api/collections/{id}` renvoie le fournisseur (`providers`), CORS autorisé.

Carte : `follow` (« Suivre », défaut) centre la carte sur la photo sélectionnée à chaque changement de sélection
(`stop()` puis `easeTo` 180 ms, pour enchaîner les touches) ; jamais lors d'une modification de point.
`centerTick` : recentrage ponctuel (« ◎ Centrer »).

## Publication Panoramax

`panoramax.py` + `routes_publish.py`. **Connexion** : `POST {instance}/api/auth/tokens/generate` → jeton + lien
`claim` ; l'utilisateur ouvre le lien et se connecte sur l'instance ; `GET /api/users/me` avec le jeton répond 200
une fois le jeton réclamé (`check`). Réglages et jetons dans `<DATA_DIR>/panoramax.json` (droits 600, écriture
atomique) ; `GET /api/panoramax` ne renvoie jamais le jeton (décision : pas de trousseau système, absent sous
Docker). **Publication** (tâche `publish`) : par séquence, fichiers du dernier export (`report.items` : photo →
fichier exporté, écrit par `exporter.run` ; un export plus ancien sans cette liste, ou une séquence « à
réexporter », est réexporté d'abord avec les mêmes réglages) ; `POST /api/upload_sets` (`title`, `no_split`,
`no_deduplication`, `sort_method: time-asc`, `estimated_nb_files`, `visibility`, `semantics` choisies dans la section « Publier sur Panoramax » de l'onglet Export et envoi (`Publication.tsx` : `usePublishOptions`,
`PublishOptionsPanel` avec « Publier les n séquences exportées non publiées » en un seul `api.publish(ids)`, bouton
`PublishButton` sur chaque séquence exportée) (`transport` walk / bike / car comme sur le site
Panoramax, plus attributs libres `clé=valeur` ; validées par `normalize_semantics`, absentes si aucune ; les
dernières utilisées sont gardées dans `panoramax.json` et renvoyées par `GET /api/panoramax`) ;
jamais `relative_heading`) ; envoi des fichiers (3 en parallèle, `POST …/files`, 409 `existing_item` = déjà reçu) ;
`POST …/complete` ; attente de `dispatched` et de photos toutes traitées (`items_status.preparing` /
`not_processed` à 0, 30 min max) ; vérification : 1 collection de `nb_items` photos. Tables `publication` (un envoi
= une ligne : état `uploading` → `processing` → `ready` / `error`) et `published_photo` (photo → `picture_id`,
pour le lien vers le viewer `#focus=pic&pic=…` et pour l'étape « modifier une séquence publiée »). Reprise : une
publication restée `uploading` reprend dans le même upload set (`GET …/files`). `list_with_stats` :
`last_publication`, `changed_since_publication`. Tests : `test_publish.py` (faux serveur `httpx.MockTransport` :
connexion, jeton privé, paramètres de l'envoi, reprise, réexport préalable). Un envoi réel n'a pas été testé :
à faire avec le compte de l'utilisateur, en visibilité « moi seulement ».

## Séquences déjà publiées (corrections)

`panoramax.py` (`link`, `compare`, `push`, `revert`), routes `…/sequences/{sid}/panoramax/{link,compare,push,revert}`,
interface `PublishedEdit.tsx` (onglet Séquences). L'API Panoramax permet de modifier une photo publiée
(`PATCH /api/collections/{seq}/items/{pic}` : `latitude`/`longitude`, `heading` → `heading_computed = false`,
`yaw`/`pitch`/`roll` = ce que lit le viewer) et de la supprimer (`DELETE`) ; pas de remplacement d'image, d'ajout ni
de découpe. Les séquences publiées ailleurs se corrigent dans un **projet Panoramax** (ci-dessous).
**Comparaison** : valeurs attendues = ce qu'écrit l'export (`_expected` : position effective, cap final arrondi
comme Panoramax avec la règle « 0 → 0,6 », lacet 0–360) contre `geometry`, `view:azimuth`, `pers:*` ; écarts :
position > 0,5 m, cap ≥ 1°, lacet > 0,5°, tangage/roulis nuls alors qu'un lacet est attendu (→ 0,01). Photos
exclues ou sorties de la séquence → suppression proposée ; photos sans `published_photo` → « à republier ».
**Envoi** (tâche `publish_update`) : PATCH des seules photos différentes (3 en parallèle), DELETE si demandé ;
valeurs serveur d'avant gardées dans `published_edit` (retour en arrière) ; sans erreur, la date de la publication
est avancée (`changed_since_publication` retombe). Tests : `test_publish.py` (faux serveur avec photos paginées).

## Projets Panoramax (séquences déjà publiées)

`meta.kind = 'panoramax'` (`db.create_project(name, kind, meta)`, `db.is_panoramax`), `meta.pnx_instance`,
`meta.pnx_collections`. Création : `POST /api/panoramax/projects` (séquences du compte :
`GET /api/panoramax/my-sequences` ← `GET {instance}/api/users/me/collection`, liens `child`), tâche `pnx_import`
(`panoramax.import_sequences`) : une ligne `photo` par image, **sans fichier** (`path = 'pnx:<picture id>'`,
`size`/`mtime` à 0), `lat_orig/lon_orig` = géométrie, `heading_exif` et `heading_manual` = `view:azimuth` (le cap
Panoramax est gardé tel quel ; « Revenir au cap calculé » efface `heading_manual`), `yaw_offset` = `pers:yaw`
ramené à ±180, `pitch_orig` / `roll_orig` = `pers:pitch` / `pers:roll` (affichage seulement : la visionneuse
applique `sphereCorrection = {pan: yaw, tilt: −pitch, roll}` comme le viewer Panoramax ; jamais modifiés) ; une `sequence` par séquence publiée + `publication` (`ready`) + `published_photo` : comparer /
envoyer / remettre fonctionnent sans changement. Juste après l'import, la comparaison est vide (sauf lacet sans
tangage/roulis, que le viewer n'applique pas : 0,01 proposé). Images : miniatures téléchargées
(`importer.thumbnails`, échec réseau → `thumb = -1` sans marquer la photo illisible) ; `GET …/photos/{id}/image`
relaie `sd.jpg` (`?hd=1` : `hd.jpg`, lien « Original »), avec le jeton pour les séquences privées. Garde
`routes_edit.ride_only` (409) sur l'import, la vérification des fichiers, la création / découpe / fusion /
limites / suppression de séquences, l'export, le réexport, les sources et la publication. Interface : `isPnx` dans
`ProjectView` (pas d'*Importer*, de *Couper*, de *Début/Fin* ni des touches D/F/C ; onglet *Envoyer* =
`SendTab.tsx`), `SequencesTab` (`pnx`), `NewPanoramaxProject.tsx` (accueil), `PnxConnection` (dans
`Publication.tsx`, partagé). Tests : `test_publish.py` (`FakeAccount`).

## Réexport

`sequence.modified_at` : posé par `undo.undoable` (et par annuler / rétablir) sur les séquences dont le contenu
change (`undo.affected_sequences` : photos qui entrent, sortent ou sont modifiées, ou ligne de la séquence), et
sur toutes par un changement des réglages de cap (`undo.touch_all`). `exporter.last_exports` donne le dernier export
de chaque séquence (dossier racine, mode et options, enregistrés dans le rapport) ; `needs_export` = jamais
exportée, modifiée depuis, ou dernier export avec des problèmes. `POST …/sequences/{id}/reexport` relance
`export_start` avec ces réglages pour cette seule séquence. `modified_at` fait partie de `undo.SEQ_COLS` pour
survivre à la réécriture de la table par annuler / rétablir (anciennes entrées du journal : complétées par NULL).
Onglet Export : une séquence est cochée par défaut si `needs_export` ; les clics de l'utilisateur sont des
exceptions (`overrides`) oubliées dès que l'état d'export d'une séquence change. `ProjectView` recharge les
séquences quand la liste des tâches terminées change (`finishedJobs`), y compris pour une tâche finie avant le
premier rafraîchissement (réexport court).

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

Dossiers : `<nom du projet>_<n>` (`exporter.plan`), n = 1, 2, 3… dans l'ordre des séquences dans la sortie.

ExifTool en lot (`writer.run_batch`) : avec `-execute`, les options ne valent que pour une commande ; elles sont donc
répétées pour chaque fichier (`-q -q`, `-n`…). Seules les lignes « Error » sont des échecs : les vraies photos
GoPro MAX produisent « Warning: [minor] Maker notes could not be parsed », qui était compté à tort comme un problème
de vérification sur tous les fichiers sauf le premier du lot (`test_gopro_maker_notes_warnings_are_not_errors`).

Règle Panoramax (option, activée par défaut) : un cap qui s'arrondit à 0° est écrit 0,6°, car Panoramax arrondit à
l'entier et recalcule les caps nuls.

## Détection des sauts GPS

`analysis.detect` parcourt les photos géolocalisées en gardant une position de référence. Un déplacement est anormal
si la distance dépasse `jump_min_m` **et** la vitesse implicite `jump_speed_ms` (pas après une interruption).
Si la photo suivante est cohérente avec la référence, c'est un saut isolé : la référence n'est pas mise à jour.
Sinon c'est un décalage durable : la photo est signalée une fois et devient la référence.
Seuils modifiables par projet (`PATCH /api/projects/{id}` `{"settings": {...}}`).

## Barre d'étapes

`StepBar.tsx`, sous la barre d'outils : calculée côté interface à partir de ce qui est déjà chargé (`photos`,
`sequences`, `project.summary`, points à vérifier `quality`), sans route dédiée. Étapes dans l'ordre de travail :
import, synchro (photos `pos_method = 'time'`, décalage `sync_offset_s` de `GET /api/projects/{id}`, méta
`last_time_offset`), doublons et arrêts (`quality` `stop`), correction GPS (photos sans position, `GPS_JUMP` sans `pos_method`,
autres points de `quality`), séquences (photos utilisables non classées), export (`last_export`, `needs_export`),
envoi (`last_publication`, `changed_since_publication`) ; projet Panoramax : sans séquences ni export. États
`ok` / `warn` / `todo` ; `onTab` ouvre un onglet, `onShow` sélectionne des photos (onglet Photo). `.workspace` est
une colonne flex (barre d'outils, étapes, bandeau d'erreur, `.main`, barre des tâches).

## Langues de l'interface (i18n)

Mécanisme maison, sans dépendance, dans `frontend/src/i18n/` : `fr.ts` (référence ; ses clés typent tout), `en.ts`
(mêmes clés ; une clé manquante retombe sur le français), `index.ts` (`t`, `tp`, `useLang`, `setLang`, `locale`).
- **Ajouter un texte** : une clé `zone.nom` dans `fr.ts` et `en.ts`, puis `t('zone.nom', { param })` (`{param}` dans le
  texte). Pluriel : clés `base.one` / `base.many` (`{n}` = le nombre) et `tp('base', n)`. Texte venant des photos ou
  de Panoramax : jamais traduit, passé en paramètre, jamais inséré comme HTML.
- **Hors composant** (`shortcuts.ts`, `contextMenuItems.ts`) : appeler `t()` au moment du calcul (fonction, pas
  constante de module), sinon la langue est figée. Un composant qui affiche des `t()` appelle `useLang()` pour se
  redessiner au changement de langue.
- **Langue** : choisie dans ⚙ Réglages, mémorisée dans `localStorage` (`pss-lang`, essai protégé) ; sinon langue du
  navigateur si anglaise, sinon français. Dates : `toLocale…(locale())` (`fr-FR` / `en-GB`), jamais de `'fr-FR'` en dur.
- Texte avec gras : `rich(t('clé'))` rend `<b>…</b>` en `<strong>` (nos traductions seulement). Tables de textes
  (`issueText(kind)` dans `issues.ts`, `capHelp()` / `orientationHelp()`) : des fonctions, pas des constantes.
- Traduit aux lots 1–3 (#37) : tous les écrans (liste, Réglages, étapes, aide, menus, écran projet, export, publication,
  envoi, projet Panoramax, carte, légende, visionneuse, barre des tâches) ; restent en français : les messages du
  serveur (lot 4). Tables de textes en fonctions (`publicationStates()`, `builtinBasemaps()`, `panoramaxPresets()`).
  `tools/check_i18n.mjs` (appelé par `tools/check.sh front`) signale les lignes à accents français hors `i18n/`
  (commentaires exclus ; exceptions dans `ALLOWED`). Les tests e2e fixent `locale: 'fr-FR'`.

## Confort de l'interface

- `StopCompare.tsx` : photos d'un arrêt côte à côte, la vignette cliquée dans `Viewer360` (orientation lue par
  `api.photo`), exclusion des non gardées en un appel `excludePhotos`.
- `N` / `Maj+N` (`checkPoints` de `useIssues.ts`) : points à vérifier, sauts GPS non corrigés, photos sans position,
  photos non classées, triés par index.
  `issues.ts` : type `Issue` (`kind`, `start`, `end`, `count`, `detail` du backend, `meters`), `computeIssues`, la
  table unique des textes `ISSUE_TEXT` (titre, nom, cause, correction), prédicats partagés `isUsable` / `isPlaced`.
  `focusOn` y va et l'explique dans `CheckCard.tsx` (haut de l'onglet Photo : précision, cause, correction, actions ;
  `fixIssue` pour les actions, exclusion confirmée) ; le point est recherché dans la liste à chaque rendu : disparu =
  « Corrigé ✓ ». `focusFirst(kinds)` sert à l'étape *Correction GPS* ; l'encadré est retiré quand la photo courante
  sort de `start..end`.
  `IssuesPanel.tsx` : fenêtre flottante (`useDraggable`, partagé avec `OsmSnapPanel`) des problèmes d'une étape
  (`STEP_KINDS`), groupés avec cause et correction (`ISSUE_TEXT`) ; ouverte par la `StepBar` (`onIssues`) ; plus de
  listes de corrections dans le *Bilan*.
- `MapLegend.tsx` (repliée par défaut, `localStorage` `pss-legend`, avec les classes d'âge de la couverture Panoramax
  quand elle est affichée) ; pastille de sélection (`.selection-chip`) ;
  carte et légende dans `.map-area` (relatif à la carte, pas à la timeline).
- `Timeline` : bulle au survol (`HoverBubble`), zoom gardé sous `pss-timeline-<projet>` si le nombre de photos n'a
  pas changé ; photo et onglet gardés sous `pss-view-<projet>`.
- `SettingsDialog.tsx` (bouton ⚙ Réglages, avec `OverlayUrl` et `HeadingSettings`) : surcouche Panoramax, fonds XYZ
  ajoutés (hook `useCustomBasemaps` : ajout / retrait, retrait confirmé),
  calcul du cap du projet (`HeadingSettings`) ; le *Bilan* ne garde que le bilan, la maintenance et les corrections
  sur toute la sortie.
- `Dialogs.tsx` : `Confirm` (Entrée / Échap) et `AddBasemap` ; plus aucun `window.confirm` / `prompt`.
- `JobBar` : temps restant d'après la vitesse observée depuis l'ouverture ; notification (`Notification`) à la fin
  d'une tâche de plus de 10 s si la fenêtre est cachée et l'autorisation donnée.
- Carte : seules les corrections à la main sont entourées en violet (`pos_method` ≠ `time`).
- Disposition : groupes de boutons joints (`.btn-group`) séparés par `.tool-sep` dans la barre d'outils (actions
  sur la sortie) ; réglages d'affichage de la carte (Panoramax, fond, Centrer, Suivre, Exclues) dans `.map-follow` ; lignes
  alignées `.form-row` (libellé | champs) dans les cartes de plage (`.range-card`) et de séquence ; actions d'une
  séquence en pied de carte, *Supprimer* à droite.

## Points à vérifier (contrôle qualité)

`core/quality.py`, `GET /api/projects/{id}/quality` : calcul à la demande, rien n'est écrit ni modifié (le choix
de la photo à garder dans un arrêt revient à l'utilisateur). Seule exception : « Ignorer » un cap à vérifier (`POST …/quality/ignore-headings`) copie le cap
manuel dans `photo.heading_kept` (colonne éditable de `undo.PHOTO_COLS`, annulable) ; le point n'est plus signalé tant
que `heading_kept = heading_manual`. `heading_kept` est dans `undo.NOT_EXPORTED` : il ne rend pas une séquence
« à réexporter ». Photos non exclues et utilisables, dans l'ordre :
`stop` (≥ `stop_min` photos consécutives à moins de `stop_m` les unes des autres), `spacing` (> `spacing_m` entre deux
photos consécutives, pas à travers une interruption, un saut GPS ni des photos exclues), `gps_dop` (> `dop_max`),
`heading` (cap manuel à plus de `heading_diff` du cap calculé) ; seuils = réglages du projet (`config.DEFAULT_SETTINGS`, `SettingsIn`, section *Points à vérifier* de ⚙ Réglages) ;
photos consécutives regroupées en tronçons
`{kind, start_idx, end_idx, count, detail}`. Interface : rechargé à chaque rechargement des photos (`ProjectView`),
marques orange en haut de la `Timeline` (`warnings`) et section du *Bilan* (`QualityChecks`). Tests :
`test_quality.py`.

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
- SQLite : jamais d'opération longue (déplacement de fichier, réseau, ExifTool) dans `db.transaction` : le verrou
  bloque toutes les modifications (« database is locked » au bout de 30 s, renvoyé en 503 avec un message clair).
- ExifTool : les options (`-m`, `-overwrite_original`…) sont à répéter pour chaque commande d'un fichier d'arguments ;
  seules les lignes `Error` sont des erreurs.
- Interface : les photos sont rechargées après chaque action ; un raccourci pressé juste après voit l'ancien état.
- Docker : après un changement, l'utilisateur doit reconstruire (`docker compose up -d --build`).

## Tests

`backend/tests` (pytest, 56 tests) : géodésie, analyse, lecture EXIF, import complet via l'API (bilan attendu,
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
