# Renderer verification

The standalone renderer passed 22 Python tests and the production-JS DOM test. Existing Chromium and Playwright also passed the real browser interaction suite: desktop, mobile, dark mode, grouping, filters, folding, notes, flags, JSON download, reload privacy, injection probes, no external requests, CSP and no-JS fallback.

These screenshots show only the fictional bundled example, using the same renderer/assets tested in this PR. No private PR source or credentials appear. At a 375-pixel viewport, the page had no horizontal overflow; individual code views retain their own scrolling.

- [Desktop](desktop.png)
- [Mobile](mobile.png)
- [Dark mobile](dark-mobile.png)

Run `python3 -m unittest discover -s tests -p test_review_renderer.py` and `node tests/browser_review.unit.cjs`. Real-browser checks require already available Playwright and Chromium; `tests/browser_review.cjs` documents its environment overrides. No dependency installation or global activation is performed by these checks.
