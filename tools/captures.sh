#!/usr/bin/env bash
# Regenerates the user guide screenshots (doc/images/*.webp) on a simulated ride near Montpellier.
# CAPTURE_LANG=en: English interface and demo names, images in doc/images/en/ (default: fr, doc/images/).
# Needs: .venv (backend/requirements-dev.txt + pillow), frontend built (npm run build), Node with Playwright,
# network access to tile.openstreetmap.org, data.geopf.fr and api.panoramax.xyz.
# Photos and exports go to /photos and /exports (as in Docker) so that no local path shows in the captures:
# run as a user allowed to create them, or set PHOTOS_DIR / EXPORTS_DIR.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD PY=$PWD/.venv/bin/python PORT=${PORT:-8767}
LANG_ID=${CAPTURE_LANG:-fr}
if [ "$LANG_ID" = en ]; then IMG_DIR=doc/images/en N1='Ride 2 June' N2='Lez loop' N3='Ride 14 June'; else IMG_DIR=doc/images N1='Sortie 2 juin' N2='Tour du Lez' N3='Sortie 14 juin'; fi
mkdir -p "$IMG_DIR"
PHOTOS_DIR=${PHOTOS_DIR:-/photos} EXPORTS_DIR=${EXPORTS_DIR:-/exports}
WORK=$(mktemp -d) && trap 'kill $SERVER 2>/dev/null || true; rm -rf "$WORK"' EXIT
mkdir -p "$PHOTOS_DIR" "$EXPORTS_DIR"
[ -d "$PHOTOS_DIR/Sortie_14_juin" ] || "$PY" tools/make_samples.py "$PHOTOS_DIR/Sortie_14_juin" --count 400 --width 2048 --seed 7
(cd backend && PSS_DATA_DIR="$WORK/data" PSS_DEFAULT_DIR="$PHOTOS_DIR" "$ROOT/.venv/bin/uvicorn" app.main:app --port "$PORT" >"$WORK/log" 2>&1) &
SERVER=$!; sleep 4
B=http://127.0.0.1:$PORT/api/projects J='Content-Type: application/json'
post() { curl -sf -X "${3:-POST}" "$1" -H "$J" -d "$2" >/dev/null; }
post $B "{\"name\":\"$N1\"}"; post $B "{\"name\":\"$N2\"}"
PID=$(curl -sf -X POST $B -H "$J" -d "{\"name\":\"$N3\"}" | "$PY" -c 'import sys,json;print(json.load(sys.stdin)["id"])')
A=$B/$PID
post $A/import "{\"paths\":[\"$PHOTOS_DIR/Sortie_14_juin\"]}"
until curl -sf $A | "$PY" -c 'import sys,json;sys.exit(any(j["state"]=="running" for j in json.load(sys.stdin)["jobs"]))'; do sleep 2; done
post $A/photos/exclude '{"start_idx":60,"end_idx":64}'                      # a stop
post $A/sequences/bulk '{"segments":[[3,120],[121,201],[202,330]]}'         # 331+ left unclassified
post $A/timesync/apply '{"offset_s":1.5,"scope":"all","keep_manual":true}'
post $A/headings/yaw '{"sequence_id":2,"add":20}'                           # camera badly aligned on the helmet
post $A/export "{\"out_dir\":\"$EXPORTS_DIR\",\"sequence_ids\":[1,2]}"
until curl -sf $A | "$PY" -c 'import sys,json;sys.exit(any(j["state"]=="running" for j in json.load(sys.stdin)["jobs"]))'; do sleep 2; done
post $A/headings/offset '{"start_idx":121,"end_idx":201,"value":2}'       # sequence 2: « à réexporter »
mkdir -p "$WORK/png" && node tools/captures.js "$WORK/png" "http://127.0.0.1:$PORT/" "$LANG_ID"
"$PY" -I - "$WORK/png" "$IMG_DIR" <<'PYEOF'
import os, sys
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
for f in sorted(os.listdir(src)):
    Image.open(os.path.join(src, f)).convert("RGB").save(os.path.join(dst, f[:-4] + ".webp"), "WEBP", quality=82, method=6)
    print(os.path.join(dst, f[:-4] + ".webp"))
PYEOF
