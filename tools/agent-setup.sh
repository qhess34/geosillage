#!/usr/bin/env bash
# Prépare les dépendances dans le conteneur des agents (idempotent) : .venv, node_modules, interface construite.
#   tools/agent-setup.sh
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
.venv/bin/python -V >/dev/null 2>&1 || python3 -m venv --clear .venv   # recréé si absent ou venu d'une autre machine
.venv/bin/pip install -q -r backend/requirements-dev.txt
(cd frontend && npm ci --no-audit --no-fund --silent && npm run build --silent)
(cd e2e && npm ci --no-audit --no-fund --silent)
cat <<'MSG'
Prêt. Une tâche = un worktree (jamais deux tâches dans le même dossier) :
  git worktree add ../wt/<branche> -b <branche> origin/main
  ln -s "$PWD/.venv" ../wt/<branche>/.venv    # dépendances partagées (+ frontend/node_modules, e2e/node_modules)
  git worktree remove ../wt/<branche>          # après la fusion
MSG
