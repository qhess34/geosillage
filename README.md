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
| 2b | Visionneuse 360°, liste virtualisée | à faire |
| 2d | Correction GPS : glisser sur la carte, saisie, placer une photo sans GPS, décalage et déplacement le long du trajet sur une plage ; export en copie, en déplaçant les sources, ou sur place ; restauration des sources | ✅ |
| 2d (reste) | Exports GeoJSON/CSV des positions | à faire |
| 3 | Retard GPS + calibration, GPX | à faire |
| 4 | Publication Panoramax | en attente (pas de publication pour l'instant) |

## Préparer une sortie

1. **Importer** les dossiers de la sortie (bouton *Importer*). Le bilan s'affiche dans l'onglet *Bilan*.
2. **Découper** (onglet *Séquences*) : *Découpage proposé* coupe aux interruptions de prise de vue et aux sauts de
   position ; on coche les segments à garder. Ou à la main : `D` / `F` sur la photo courante (ou glisser sur la
   timeline), puis `S`. `C` coupe la séquence avant la photo courante. `Ctrl+Z` / `Ctrl+Y` annulent / rétablissent.
3. **Corriger les positions** : `M` (ou *✥ Positions*) puis glisser le marqueur violet de la photo courante ; une
   photo sans GPS se place d'un clic sur la carte. Onglet *Photo* : saisie des coordonnées, retour à l'original ;
   sur une plage : décalage (m vers l'est / le nord) ou déplacement le long du trajet. La position d'origine reste
   visible (cercle violet et pointillés) ; un saut GPS corrigé redevient utilisable (cap, séquences, export).
4. **Vérifier les caps** : flèches sur la carte (zoom ≥ 15) ; onglet *Photo* : cadran, `[` / `]`, cap manuel ;
   décalage par séquence ; décalage ou cap fixe sur une plage. Les caps manuels ne sont jamais écrasés.
5. **Exporter** (onglet *Export*), trois modes :
   - *Copier* (par défaut) : copies, sources intactes ;
   - *Déplacer* : les photos sources sont déplacées et renommées dans un dossier par séquence, EXIF modifiés ;
   - *Sur place* : EXIF des photos sources modifiés, sans les déplacer.

   Dans les deux derniers cas une confirmation est demandée ; les valeurs d'origine des balises écrites sont
   sauvegardées dans le projet avant la première modification, et *Restaurer les photos sources* les remet et
   ramène les fichiers à leur emplacement et leur nom d'origine (positions restaurées à mieux que 0,1 mm : elles
   sont réencodées ; les données image ne sont jamais touchées). Un dossier par séquence (`01_Nom/0001_GSAC….JPG`…), avec
   `GPSImgDirection` / `GPSImgDirectionRef=T` / `XMP-GPano:PoseHeadingDegrees` (et la position si elle a été
   corrigée), sans recompression. Chaque dossier contient `photos.csv` (source, position, cap et son origine) et
   `.pss-export.json`. Les photos en saut GPS non corrigé sont exclues par défaut (leur position est fausse).
   Ré-exporter remplace l'export précédent du même projet ; un dossier étranger non vide est refusé.
   Pour envoyer plus tard un dossier comme **une seule** séquence avec la CLI Panoramax, utiliser la commande
   `upload` avec `--no-split` et `--duplicates-checks disabled` (sinon le serveur peut redécouper ou dédoublonner,
   voir `doc/ETUDE_PHASE1.md` §2.2).

## Installation (Linux)

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
