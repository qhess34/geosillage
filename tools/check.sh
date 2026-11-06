#!/usr/bin/env bash
# Vérifications avec une sortie réduite à l'essentiel.
#   tools/check.sh [back|front|e2e|all] [arguments passés à pytest / playwright]
#   tools/check.sh back backend/tests/test_osm.py      (ou : back tests/test_osm.py -k snap)
#   tools/check.sh e2e --grep "séquence"
# En cas d'échec : les 40 dernières lignes, code de sortie non nul. Le premier argument est facultatif (all).
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PY=$ROOT/.venv/bin/python
[ -x "$PY" ] || PY=python3
WHAT=${1:-all}
case "$WHAT" in back | front | e2e | all) shift || true ;; *) WHAT=all ;; esac
LOG=$(mktemp)
trap 'rm -f "$LOG"' EXIT
FAILED=0

step() { # name, directory, command...
  local name=$1 dir=$2
  shift 2
  if (cd "$dir" && "$@") >"$LOG" 2>&1; then
    echo "OK    $name : $(grep -E "passed|built in" "$LOG" | tail -1)"
  else
    echo "ÉCHEC $name (40 dernières lignes) :"
    tail -40 "$LOG"
    FAILED=1
  fi
}

back() {
  local args=("$@")
  # Accept paths written from the repository root (backend/tests/x.py).
  args=("${args[@]/#backend\//}")
  step "backend (pytest)" "$ROOT/backend" "$PY" -m pytest -q --no-header -p no:cacheprovider "${args[@]}"
}
front() { step "interface (tsc + vite)" "$ROOT/frontend" npm run build --silent -- --logLevel error; }
e2e() { step "interface (Playwright)" "$ROOT/e2e" npx playwright test --trace off --reporter=line "$@"; }

case "$WHAT" in
  back) back "$@" ;;
  front) front ;;
  e2e) e2e "$@" ;;
  all)
    back
    front
    # e2e needs the built interface
    [ "$FAILED" = 0 ] && e2e || echo "e2e ignoré (échec plus haut)"
    ;;
esac
exit $FAILED
