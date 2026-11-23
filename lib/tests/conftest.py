"""Shared pytest setup for lib/ unit tests: make REPO/lib importable (import cl, params, ...)."""

import sys
from pathlib import Path

LIB = Path(__file__).resolve().parent.parent
if str(LIB) not in sys.path:
    sys.path.insert(0, str(LIB))
