"""Discover the pure synthetic D18-v3 verifier adversarial tests."""

from __future__ import annotations

import sys
from pathlib import Path


SCRIPT_DIRECTORY = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPT_DIRECTORY) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIRECTORY))

from d18_v3_verify_selftest import D18V3VerifierSelfTest  # noqa: E402,F401
