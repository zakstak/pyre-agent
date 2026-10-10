# PR review canvas validation

Checked 2026-10-10 in Chromium 152.0.7977.82 with Python 3.14.7 and Node 26.10.0 on Zak's Linux workstation. The screenshots use the synthetic fixture [tests/fixtures/showcase-review.json](../../tests/fixtures/showcase-review.json). They contain no private code.

## Screenshots

| File | State |
| --- | --- |
| [overview-dark.png](overview-dark.png) | First screen: PR header, coverage chips, filters, and file navigator |
| [1-select-dark.png](1-select-dark.png) | Pointer selection inside one diff line, with the floating **Comment** button |
| [2-compose-dark.png](2-compose-dark.png) | The composer opens under the selected line |
| [3-thread-dark.png](3-thread-dark.png) | The saved comment sits inline under its highlighted code |
| [4-finish-dark.png](4-finish-dark.png) | **Finish review** with the comment list, overall notes, and export |
| [5-thread-light.png](5-thread-light.png) | Inline thread in light mode |
| [6-finish-light.png](6-finish-light.png) | **Finish review** in light mode after export |
| [7-orphan-dark.png](7-orphan-dark.png) | A comment whose code changed in a later snapshot, with **Attach to selected text** |
| [8-phone-dark.png](8-phone-dark.png) | First screen at 390px |
| [9-phone-thread-dark.png](9-phone-thread-dark.png) | Inline thread at 390px while the code scrolls sideways |

## Results

[results.json](results.json) records every check. All of these passed:

- A real pointer drag selects part of one line. **Comment** opens the composer inside the diff, and saving renders an inline thread with the selected text highlighted.
- The keyboard path works. Focus the row's + button, press Enter, type, and press Ctrl+Enter.
- **Finish review** lists comments in file order. Export writes both comments as attached.
- Importing that export into a later snapshot keeps the unchanged comment inline and turns the changed one into an orphan. Selecting the new code and choosing **Attach to selected text** moves it back inline.
- Every visible text element meets WCAG AA contrast in both modes. The lowest ratio is 4.68:1, a deletion count in light mode.
- No page-level horizontal scrolling at 1440, 390, and 320 pixels wide, at 100% and 200% text, in both modes.
- No external requests and no page errors.

`browser_review_focus.cjs` covers focus return after Escape and Dismiss, Undo that survives later messages, drafts hidden by a collapsed file, IME Escape, line labels that span deleted and added rows, export state while a draft is open, and selection handling under 30ms per event on a 9,990-line diff. The earlier suites also pass against the new markup: `test_review_renderer.py`, `browser_review.unit.cjs`, `browser_review.cjs`, and `browser_review_inline.cjs`.

## Reproduce

```sh
PLAYWRIGHT_MODULE=/path/to/playwright CHROMIUM_PATH=/path/to/chromium \
  node tests/browser_review_screenshots.cjs
```

The script overwrites the screenshots and `results.json` in this folder.

## Limits

These checks cover headless Chromium on Linux with synthetic viewports and doubled root text size. They do not cover Firefox, Safari, real phones, touch selection, or screen readers.
