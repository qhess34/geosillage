#!/usr/bin/env bash
# Lance Panoramax Sequence Studio sur http://127.0.0.1:8765
# 1re fois : crée l'environnement Python et construit l'interface.
set -euo pipefail
cd "$(dirname "$0")"
command -v exiftool >/dev/null || { echo "ExifTool manquant : sudo apt install libimage-exiftool-perl"; exit 1; }
if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install -q -r backend/requirements.txt
fi
if [ ! -f frontend/dist/index.html ]; then
  (cd frontend && npm ci --no-audit --no-fund && npm run build)
fi
cd backend
exec ../.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port "${PORT:-8765}"
