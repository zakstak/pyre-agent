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
            "2704cfed94bd8723d488fa7a5490a5c1d1deb8707ef53f8bec827b00baddf2e3",
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
