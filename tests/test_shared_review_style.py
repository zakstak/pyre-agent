"""Companion installation, offline embedding and canonical token drift checks."""
import hashlib
import importlib.util
import json
import re
import shutil
import tempfile
import unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
STYLE = ROOT / 'skills/internal-visual-style'
VIEWER = ROOT / 'skills/pr-review-canvas'
class SharedStyleTests(unittest.TestCase):
    def test_contract_tokens_remain_exact(self):
        raw = (STYLE / 'references/reference-theme-contract.json').read_bytes()
        self.assertEqual(hashlib.sha256(raw).hexdigest(), '4cb5c21b3d08f297b1bd8c0a81916168307d452ac6e457670e5fab11d1418d27')
        contract = json.loads(raw)
        tokens = (STYLE / 'assets/tokens.css').read_text()
        for role, dark in contract['palette']['dark'].items():
            name = re.sub(r'([A-Z])', lambda m: '-' + m[1].lower(), role)
            self.assertIn(f'--pyre-{name}: light-dark({contract["palette"]["light"][role]}, {dark});', tokens)
    def test_installed_copy_companion_and_override(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            shutil.copytree(VIEWER, root / 'pr-review-canvas')
            spec = importlib.util.spec_from_file_location('installed_renderer', root / 'pr-review-canvas/scripts/render_review.py')
            renderer = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(renderer)
            review = renderer.load_review(VIEWER / 'assets/example-review.json')
            with self.assertRaisesRegex(renderer.ValidationError, 'internal-visual-style'):
                renderer.render_review(review)
            shutil.copytree(STYLE, root / 'alternate-style')
            page = renderer.render_review(review, root / 'alternate-style')
            self.assertIn('data:font/ttf;base64,', page)
            self.assertIn('font-src data:', page)
            self.assertIn('SIL OPEN FONT LICENSE', page)
            self.assertNotIn('url("./fonts/', page)
            shutil.move(root / 'alternate-style', root / 'internal-visual-style')
            self.assertEqual(page, renderer.render_review(review))
if __name__ == '__main__': unittest.main()
