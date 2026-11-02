# Panoramax Sequence Studio

Application locale de préparation, correction et publication de séquences [Panoramax](https://panoramax.fr)
à partir de photos 360° GoPro MAX (vélo, une photo toutes les ~2 s, des milliers de photos par sortie).

Par défaut les fichiers originaux ne sont **pas modifiés** : les projets ne stockent que des références vers les
photos, les métadonnées lues et les corrections, et l'export produit des copies. Sur demande explicite (avec
confirmation), l'export peut aussi modifier les EXIF des photos sources, sur place ou en les déplaçant dans un dossier
par séquence ; les valeurs d'origine sont alors sauvegardées et « Restaurer les photos sources » les remet.

## État d'avancement

| Phase | Contenu | État |
|---|---|---|
| 1 | Étude GoPro MAX / API Panoramax, architecture ([doc/ETUDE_PHASE1.md](doc/ETUDE_PHASE1.md)) | ✅ |
| 2a | Projets, import récursif, lecture EXIF par lots, bilan d'import, anomalies, miniatures en tâche de fond, carte | ✅ |
| 2c | Séquences (plage, découpage proposé, couper, fusionner, limites), timeline, annuler/rétablir, raccourcis | ✅ |
| 2d (partiel) | Cap : calcul automatique, manuel, par plage, décalage par séquence ; **export d'un dossier par séquence avec EXIF corrigés** | ✅ |
| 2b | Visionneuse 360° (Photo Sphere Viewer), direction du vélo pour caméra sur casque | ✅ |
| 2b (reste) | Liste virtualisée | à faire |
| 2d | Correction GPS : glisser sur la carte, saisie, placer une photo sans GPS, décalage et déplacement le long du trajet sur une plage ; export en copie, en déplaçant les sources, ou sur place ; restauration des sources | ✅ |
| 2d (reste) | Exports GeoJSON/CSV des positions | à faire |
| 3 (partiel) | **Retard GPS** : synchronisation en faisant glisser une photo le long de la trace sur la vue satellite, points de calage, application à la sortie / séquence / plage ; visionneuse zoomable | ✅ |
| 3 (reste) | Import GPX, magnétisme OSM | à faire |
| 4 | Publication Panoramax | en attente (pas de publication pour l'instant) |

## Préparer une sortie

1. **Importer** les dossiers de la sortie (bouton *Importer*). Le bilan s'affiche dans l'onglet *Bilan*.
2. **Découper** en parcourant la sortie dans la visionneuse 360° (← → ; Maj : par 10) :
   - à la main : *⏵ Début* (`D`) sur la première photo, naviguer (la plage suit, en jaune), puis *⏹ Fin* (`F`) sur
     la dernière : la séquence est créée (boutons dans la barre d'outils et sous la visionneuse) ; la photo suivante
     devient aussitôt le *Début* de la séquence suivante (si elle est exclue avec `X`, c'est la suivante non exclue) :
     il suffit d'enchaîner `F` à la fin de chaque séquence (`Échap` annule le début) ;
   - `C` (ou *✂ Couper ici*) sur la première photo de chaque nouvelle séquence : sur une photo non classée, la
     séquence est créée autour d'elle puis coupée ; il suffit donc d'appuyer sur `C` à chaque coupure ;
   - *Tout en séquences* (onglet *Séquences*) : une séquence par bloc de photos non classées ;
   - une plage tracée sur la timeline (glisser, ou Maj+clic) se transforme aussi en séquence avec *⏹ Fin* ;
   - *Découpage proposé* : coupe aux interruptions de prise de vue et aux sauts de position, à valider ;
   - `X` (ou `Suppr`) **exclut** la photo et passe à la suivante (appuyer plusieurs fois supprime une série ;
     avec une plage tracée sur la timeline : toute la plage, après confirmation ; `Ctrl+Z` annule) ; les photos exclues sont masquées sur la carte et sautées par ← → (case
     *Exclues* de la carte pour les revoir) ; `Maj+X` réintègre la photo courante. Une photo exclue n'est dans aucune séquence et n'est
     jamais exportée ; onglet *Export* : ses fichiers peuvent être déplacés dans un dossier `_exclues` (rien
     n'est supprimé, *Restaurer les photos sources* les remet).
   - `Ctrl+Z` / `Ctrl+Y` annulent / rétablissent ; `?` affiche tous les raccourcis.
   - Visionneuse : *⟲ Recentrer* remet la vue face à l'avant ; la flèche jaune de la photo sur la carte tourne avec
     la direction regardée.
   - Carte : *Suivre* (coché par défaut) garde la photo courante au centre pendant la navigation ; décoché, la carte
     reste fixe et *◎ Centrer* recentre à la demande.
   - Bouton *Panoramax* : surcouche facultative des photos 360° **déjà publiées** sur Panoramax, colorées selon leur
     âge (moins d'un an / 1 à 3 ans / plus de 3 ans), date, appareil et auteur au survol ; séquences à partir du zoom 7,
     photos à partir du zoom 15. Source réglable dans l'onglet *Bilan* : par défaut **toutes les instances** (méta-catalogue
     `api.panoramax.xyz`, celui de panoramax.fr), ou une seule instance (OSM France, IGN, autre adresse).
3. **Corriger le retard GPS** (onglet *Synchro*, fond satellite : en France, *Satellite IGN Ortho* — orthophotos
   IGN d'environ 20 cm, souvent plus nettes qu'Esri ; la variante *zoom max* demande les dalles jusqu'au zoom 21
   là où l'IGN a de la très haute résolution, et peut rester vide ailleurs aux plus forts zooms) : la GoPro enregistre la position avec 0,5 à 3 s
   de retard. Choisir une photo où l'on voit un repère visible sur la vue satellite (passage piéton, angle de
   bâtiment…), l'agrandir (molette dans la visionneuse), puis faire glisser le marqueur orange : il ne peut aller
   que **le long de la trace**, et le décalage en secondes s'affiche ; toutes les photos se décalent en aperçu
   (points orange). Vérifier sur d'autres photos (← →), enregistrer des points de calage (la médiane est proposée),
   puis appliquer à toute la sortie, à la séquence ou à une plage. Chaque photo est alors placée sur la trace à
   l'instant de prise de vue + décalage ; les sauts GPS et photos sans GPS reçoivent aussi une position. Les
   positions corrigées à la main sont gardées (option). Annulable.
   Conseil : caler sur une portion où la trace suit bien la route — si le GPS est décalé latéralement (rue
   parallèle), la projection sur la trace donne un décalage faux.
4. **Corriger les positions** : `M` (ou *✥ Positions*) puis glisser le marqueur violet de la photo courante ; une
   photo sans GPS se place d'un clic sur la carte. Onglet *Photo* : saisie des coordonnées, retour à l'original ;
   sur une plage : décalage (m vers l'est / le nord) ou déplacement le long du trajet. La position d'origine reste
   visible (cercle violet et pointillés) ; un saut GPS corrigé redevient utilisable (cap, séquences, export).
   *Reporter la correction (→)* (case sur la carte en mode Positions, cochée par défaut, désactivable) : après avoir
   déplacé le point d'une photo à la main, `→` déplace de la même façon la photo suivante (y compris une position
   synchronisée), sauf si elle a été corrigée à la main ; on corrige la première d'une série décalée puis on avance
   (`Ctrl+Z` annule un report).
5. **Vérifier les caps** : flèches sur la carte (zoom ≥ 15), chacune vers la photo suivante ; onglet *Photo* :
   cadran, `[` / `]`, cap manuel ; décalage par séquence ; décalage ou cap fixe sur une plage. Les caps manuels ne
   sont jamais écrasés.
   **Caméra sur casque** : le centre de l'image suit la tête, pas le vélo. Dans la visionneuse, tourner la vue vers
   la route devant le vélo puis *🚲 Fixer la direction du vélo* (sur la photo, ou sur toute la plage sélectionnée) :
   l'angle de la tête est écrit dans `XMP-GPano:PoseHeadingDegrees` (lacet, lu par Panoramax pour orienter la
   sphère), `GPSImgDirection` reste la direction du vélo, et la visionneuse s'ouvre alors face à la route.
   **Caméra montée à l'envers** : *↻ 180° toutes les photos* (onglet *Séquences*, tout le projet, photos non classées
   comprises), *↻ 180°* sur une séquence (onglet *Séquences*) ou sur une plage (onglet *Photo*)
   ajoute 180° à l'orientation de toutes ses photos (en plus des angles de tête déjà fixés) ; le JPEG n'est pas
   modifié, seule `PoseHeadingDegrees` change. Recliquer revient à l'état précédent.
   Le viewer Panoramax n'applique cette orientation que si le tangage et le roulis sont non nuls : l'export remplace
   alors le 0,0 de la GoPro par 0,01° (invisible), comme [pan360-fixexif](https://github.com/qhess34/pan360-fixexif).
   Photos déjà publiées sans ce correctif : les corriger dans pan360-fixexif, ou les republier depuis un nouvel export.
6. **Exporter** (onglet *Export*), trois modes :
   - *Copier* (par défaut) : copies, sources intactes ;
   - *Déplacer* : les photos sources sont déplacées et renommées dans un dossier par séquence, EXIF modifiés ;
   - *Sur place* : EXIF des photos sources modifiés, sans les déplacer.

   Dans les deux derniers cas une confirmation est demandée ; les valeurs d'origine des balises écrites sont
   sauvegardées dans le projet avant la première modification, et *Restaurer les photos sources* les remet et
   ramène les fichiers à leur emplacement et leur nom d'origine (positions restaurées à mieux que 0,1 mm : elles
   sont réencodées ; les données image ne sont jamais touchées). Un dossier par séquence, nommé `<nom du projet>_<n>` avec n = 1, 2, 3… dans l'ordre de la sortie
   (`Sortie_14_juin_1/0001_GSAC….JPG`…), avec
   `GPSImgDirection` / `GPSImgDirectionRef=T`, `GPSSpeed` (km/h, calculée sur la trajectoire), `GPSVersionID` 2.3,
   et la position si elle a été corrigée, sans recompression. `XMP-GPano:PoseHeadingDegrees` reçoit l'orientation
   fixée (sinon il garde le 0,0 de la GoPro) ; dans ce cas seulement, un tangage / roulis nul devient 0,01° pour que
   Panoramax l'applique (sinon ils ne sont pas modifiés : Panoramax redresse l'horizon). Chaque dossier contient `photos.csv` (source, position, cap et son origine) et
   `.pss-export.json`. Les photos en saut GPS non corrigé sont exclues par défaut (leur position est fausse).
   Ré-exporter remplace l'export précédent du même projet ; un dossier étranger non vide est refusé.
   **Réexporter une séquence modifiée** : toute modification d'une séquence (photos, positions, caps, orientation,
   nom…) la marque *à réexporter* (onglet *Séquences* et *Export*) ; *⟳ Réexporter* relance l'export de cette seule
   séquence avec le dossier, le mode et les options de son dernier export (confirmation si le mode modifie les
   photos sources). Onglet *Export* : seules les séquences jamais exportées ou modifiées depuis leur dernier export
   (export ou réexport) sont cochées ; *Tout cocher* pour tout réexporter. Le dossier de destination est prérempli
   avec celui du dernier export du projet.
   Pour envoyer plus tard un dossier comme **une seule** séquence avec la CLI Panoramax, utiliser la commande
   `upload` avec `--no-split` et `--duplicates-checks disabled` (sinon le serveur peut redécouper ou dédoublonner,
   voir `doc/ETUDE_PHASE1.md` §2.2).

## Lancement avec Docker (recommandé)

```sh
cp .env.example .env        # puis indiquer PHOTOS_DIR (vos sorties GoPro), et PUID/PGID (commande : id -u ; id -g)
mkdir -p data photos exports  # (ou les dossiers indiqués dans .env) : à créer AVANT le premier lancement
docker compose up -d --build
```

Puis ouvrir http://127.0.0.1:8765 (publié sur cette machine uniquement : l'API donne accès aux dossiers montés).

Dans l'application, les dossiers montés apparaissent ainsi :

| Dans l'application | Sur votre machine (`.env`) | Rôle |
|---|---|---|
| `/photos` | `PHOTOS_DIR` | photos à importer ; modes d'export *Déplacer* / *Sur place* (ex. `/photos/sequences`) |
| `/exports` | `EXPORTS_DIR` | exports en mode *Copier* |
| `/data` | `DATA_DIR` | projets (bases SQLite, miniatures) |

- Le conteneur tourne avec l'utilisateur `PUID:PGID` : les exports et les photos modifiées ou déplacées gardent ce
  propriétaire. Si les dossiers n'existent pas, Docker les crée en root et l'application s'arrête avec un message
  explicite (`docker compose logs`).
- Les chemins enregistrés dans un projet sont ceux vus par le conteneur (`/photos/…`) : un projet créé avec Docker
  s'utilise avec Docker (et inversement pour `run.sh`).
- Mise à jour : `git pull && docker compose up -d --build`. Arrêt : `docker compose down` (les projets restent dans
  `DATA_DIR`).

## Installation sans Docker (Linux)

Prérequis : Python ≥ 3.11, Node.js ≥ 20, ExifTool.

```sh
sudo apt install libimage-exiftool-perl
./run.sh          # 1re fois : crée .venv, construit l'interface ; puis http://127.0.0.1:8765
```

Les projets sont stockés dans `~/.local/share/panoramax-studio/projects/<id>/` (`project.sqlite` + `thumbs/`),
ou dans `$PSS_DATA_DIR/projects`.

## Développement

```sh
python3 -m venv .venv && .venv/bin/pip install -r backend/requirements-dev.txt
cd backend && ../.venv/bin/uvicorn app.main:app --reload --port 8765   # API
cd frontend && npm ci && npm run dev                                     # interface (proxy /api → 8765)
cd backend && ../.venv/bin/python -m pytest                              # tests
```

Jeu de photos de test (format GoPro MAX simulé, avec retard GPS, bruit, sauts, interruption, doublon, fichier corrompu
et vérité terrain en CSV) :

```sh
.venv/bin/python tools/make_samples.py /tmp/sortie --count 5000 --width 1024
```

Le fonctionnement interne est décrit dans [doc/GUIDE_CODE.md](doc/GUIDE_CODE.md).
