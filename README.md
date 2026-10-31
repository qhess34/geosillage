# Panoramax Sequence Studio

Application locale de préparation, correction et publication de séquences [Panoramax](https://panoramax.fr)
à partir de photos 360° GoPro MAX (vélo, une photo toutes les ~2 s, des milliers de photos par sortie).

Les fichiers originaux ne sont **jamais modifiés** : les projets ne stockent que des références vers les photos,
les métadonnées lues et les corrections. Les copies destinées à la publication seront générées à part.

## État d'avancement

| Phase | Contenu | État |
|---|---|---|
| 1 | Étude GoPro MAX / API Panoramax, architecture ([doc/ETUDE_PHASE1.md](doc/ETUDE_PHASE1.md)) | ✅ |
| 2a | Projets, import récursif, lecture EXIF par lots, bilan d'import, anomalies, miniatures en tâche de fond, carte | ✅ |
| 2b | Visionneuse 360°, timeline, liste virtualisée, navigation | à faire |
| 2c | Découpage en séquences, annuler/rétablir | à faire |
| 2d | Corrections GPS, heading, écriture EXIF des copies, exports | à faire |
| 3 | Retard GPS + calibration, coupures proposées, GPX | à faire |
| 4 | Publication Panoramax | à faire |

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
