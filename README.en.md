<p align="center">
  <img src="frontend/public/logo.svg" alt="GeoSillage" width="120" />
</p>

<p align="center"><a href="README.md">Français</a> · <b>English</b></p>

# GeoSillage

**Prepare and fix your 360° photo rides for [Panoramax](https://panoramax.fr).**

Local application for preparing, correcting and publishing [Panoramax](https://panoramax.fr) sequences from
GoPro MAX 360° photos (bike, on foot, by car…; one photo about every 2 s, thousands of photos per ride).

By default the original files are **not modified**: projects only store references to the photos, the metadata read
from them and the corrections, and export produces copies. On explicit request (with confirmation), the export can also
edit the EXIF of the source photos, either in place or by moving them into one folder per sequence; the original values
are then saved and “Restore source photos” puts them back.

## Progress

| Phase | Content | Status |
|---|---|---|
| 1 | GoPro MAX study / Panoramax API, architecture ([doc/ETUDE_PHASE1.md](doc/ETUDE_PHASE1.md), in French) | ✅ |
| 2a | Projects, recursive import, batch EXIF reading, import summary, anomalies, thumbnails in the background, map | ✅ |
| 2c | Sequences (range, suggested split, cut, merge, limits), timeline, undo/redo, shortcuts | ✅ |
| 2d (partial) | Heading: automatic computation, manual, by range, offset over the whole ride or a series of photos; **export of one folder per sequence with corrected EXIF** | ✅ |
| 2b | 360° viewer (Photo Sphere Viewer), direction of travel for a helmet camera | ✅ |
| 2d | GPS correction: drag on the map, typing, placing a photo without GPS, offset and moving along the track over a range; export as a copy, by moving the sources, or in place; restoring the sources | ✅ |
| 2e | Photos without position: list per gap, neighbours on the map, interpolation, attachment to the sequence | ✅ |
| 3 (addition) | Sync by stretches (“From this photo”); automatic checks on GitHub | ✅ |
| 3 (partial) | **GPS delay**: synchronisation by dragging a photo along the track on the satellite view, calibration points, applied to the ride / sequence / range; zoomable viewer | ✅ |
| 3 | Snapping a selection onto OSM ways (stretches, choice of the way if ambiguous, preview) | ✅ |
| 3 (remaining) | GPX import: reference track for the sync (time offset detected) and snapping a range onto the GPX line | ✅ |
| 4 | Panoramax publishing per sequence (“Publish” button of each exported sequence, Export and send tab, login by validation link, attributes: travel mode and free attributes, resuming an interrupted upload) | ✅ |
| 4 (continued) | Panoramax project: correcting sequences already published (chosen from your account), sending only the differences, rollback | ✅ |
| Quality | Points to check before publishing (stops, large gaps, GPS accuracy, headings): Summary and timeline | ✅ |
| Interface | Step bar (import, sync, duplicates and stops, GPS correction, sequences, export, send): status and direct access | ✅ |
| Interface | Compare the photos of a stop, N / Shift+N, selection badge, legend, timeline hover, state restoration, confirmations in the page, end-of-task notifications, grouped buttons | ✅ |
| Quality | Interface tests (Playwright, `e2e/`) in the automatic GitHub checks | ✅ |

## Documentation

| For | Document |
|---|---|
| **Using the tool** (screen by screen, shortcuts, FAQ) | [doc/USER_GUIDE.md](doc/USER_GUIDE.md) |
| Developing (installation, checks, recipes, conventions) | [doc/DEVELOPPEMENT.md](doc/DEVELOPPEMENT.md) (in French) |
| AI agents: repository rules | [AGENTS.md](AGENTS.md) (in French) |
| AI organisation: roles, model choice, life cycle of a request | [doc/ORGANISATION_IA.md](doc/ORGANISATION_IA.md) (in French) |
| Internal workings (modules, data, algorithms, pitfalls) | [doc/GUIDE_CODE.md](doc/GUIDE_CODE.md) (in French) |
| GoPro MAX study / Panoramax API | [doc/ETUDE_PHASE1.md](doc/ETUDE_PHASE1.md) (in French) |

## Preparing a ride in brief

1. **Import** the folders of the ride; the summary (GPS anomalies, duplicates, interruptions) is in *Summary*.
2. **Split** into sequences while browsing the photos (← →): `D` start, `F` end (the next one starts right away),
   `C` cut, `X` exclude; or use the automatic suggested split.
3. **Correct the GPS delay** (*Sync*): drag a photo along the track on the satellite view.
4. **Correct the positions** (`M`): drag the point; `→` carries the same correction over to the following photos.
5. **Check headings and orientation**: direction of travel for a helmet camera, correction of the mounting.
6. **Export** one folder per sequence (`<project>_1`, `_2`…) with corrected EXIF; re-export what has changed.
7. Publish each folder on Panoramax as a single sequence.

Everything can be undone (`Ctrl+Z`); `?` shows the keyboard shortcuts. Details: [user guide](doc/USER_GUIDE.md).

## Launching with Docker (recommended)

```sh
cp .env.example .env        # then set PHOTOS_DIR (your GoPro rides), and PUID/PGID (commands: id -u ; id -g)
mkdir -p data photos exports  # (or the folders set in .env): create them BEFORE the first launch
docker compose up -d --build
```

Then open http://127.0.0.1:8765 (published on this machine only: the API gives access to the mounted folders).

Inside the application, the mounted folders appear as follows:

| In the application | On your machine (`.env`) | Role |
|---|---|---|
| `/photos` | `PHOTOS_DIR` | photos to import; export modes that move or edit the source photos (e.g. `/photos/sequences`) |
| `/exports` | `EXPORTS_DIR` | exports in *Copy into one folder per sequence* mode |
| `/data` | `DATA_DIR` | projects (SQLite databases, thumbnails) |

- The container runs as user `PUID:PGID`: exports and photos that are modified or moved keep that owner. If the folders
  do not exist, Docker creates them as root and the application stops with an explicit message (`docker compose logs`).
- The paths stored in a project are those seen by the container (`/photos/…`): a project created with Docker is used
  with Docker (and the other way round for `run.sh`).
- Update: `git pull && docker compose up -d --build`. Stop: `docker compose down` (projects remain in `DATA_DIR`).

## Installation without Docker (Linux)

Requirements: Python ≥ 3.11, Node.js ≥ 20, ExifTool.

```sh
sudo apt install libimage-exiftool-perl
./run.sh          # first time: creates .venv, builds the interface; then http://127.0.0.1:8765
```

Projects are stored in `~/.local/share/panoramax-studio/projects/<id>/` (`project.sqlite` + `thumbs/`),
or in `$PSS_DATA_DIR/projects`.

## Development

```sh
python3 -m venv .venv && .venv/bin/pip install -r backend/requirements-dev.txt
cd backend && ../.venv/bin/uvicorn app.main:app --reload --port 8765   # API
cd frontend && npm ci && npm run dev                                     # interface (proxy /api → 8765)
cd backend && ../.venv/bin/python -m pytest -q                           # tests
```

Checks before committing, end-to-end tests and recipes: [doc/DEVELOPPEMENT.md](doc/DEVELOPPEMENT.md) (in French).
AI agents: [AGENTS.md](AGENTS.md) (in French).

## License

© 2026 qhess34 and the GeoSillage contributors. Free software under the
[European Union Public Licence (EUPL) v1.2](LICENSE) (official text in French:
[joinup.ec.europa.eu](https://joinup.ec.europa.eu/collection/eupl/eupl-text-eupl-12)). Compatible in particular with
GPL v3 and AGPL v3. The libraries used keep their own licences (MIT, BSD, Apache…); ExifTool is a separate program
(Perl licence).
