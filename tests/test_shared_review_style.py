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
            "072ad98e03993cd68fed0b78b8d5637611bef203984728f802cdfc9e583ae3ce",
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
