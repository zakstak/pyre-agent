"""Canonical token drift checks for the internal visual style."""

import hashlib
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STYLE = ROOT / "skills/internal-visual-style"


class SharedStyleTests(unittest.TestCase):
    def test_contract_tokens_remain_exact(self):
        raw = (STYLE / "references/reference-theme-contract.json").read_bytes()
        self.assertEqual(
            hashlib.sha256(raw).hexdigest(),
            "4cb5c21b3d08f297b1bd8c0a81916168307d452ac6e457670e5fab11d1418d27",
        )
        contract = json.loads(raw)
        tokens = (STYLE / "assets/tokens.css").read_text()
        for role, dark in contract["palette"]["dark"].items():
            name = re.sub(r"([A-Z])", lambda m: "-" + m[1].lower(), role)
            self.assertIn(
                f"--pyre-{name}: light-dark({contract['palette']['light'][role]}, {dark});",
                tokens,
            )


if __name__ == "__main__":
    unittest.main()
