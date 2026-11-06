#!/usr/bin/env bash
# Started by Playwright (webServer): the real backend serving the built interface, on a fresh data folder, with a
# simulated ride (tools/make_samples.py, generated once into e2e/.cache) as the folder to import from.
# Needs: frontend built (npm run build in frontend/), Python with backend/requirements.txt, ExifTool.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
PY=${PYTHON:-$ROOT/.venv/bin/python}
[ -x "$PY" ] || PY=python3
CACHE=$ROOT/e2e/.cache
[ -d "$CACHE/photos/Sortie_test/100GOPRO" ] || "$PY" tools/make_samples.py "$CACHE/photos/Sortie_test" --count 160 --width 512 --seed 5
DATA=$(mktemp -d)
mkdir -p "$CACHE/photos/Sortie_test/sous-dossier/encore"
cd backend
exec env PSS_DATA_DIR="$DATA" PSS_DEFAULT_DIR="$CACHE/photos" "$PY" -m uvicorn app.main:app --port "${E2E_PORT:-8799}" --log-level warning
