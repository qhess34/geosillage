"""Constants duplicated in the interface (frontend/src/api.ts) must match the backend ones."""

import re
from pathlib import Path

from app.core import positions

API_TS = Path(__file__).resolve().parents[2] / "frontend" / "src" / "api.ts"


def test_manual_methods_match_the_backend():
    m = re.search(r"export const MANUAL_METHODS = \[([^\]]*)\]", API_TS.read_text(encoding="utf-8"))
    assert m, "MANUAL_METHODS introuvable dans api.ts"
    assert re.findall(r"'([^']+)'", m.group(1)) == list(positions.MANUAL_METHODS)
