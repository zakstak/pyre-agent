# Internal visual style validation

Checked 2026-10-10 in Chromium 152.0.7977.82 on Zak's Linux workstation. The page under test is the component specimen, [reference.html](../../skills/internal-visual-style/assets/reference.html), served from a temporary copy of the complete skill folder.

## Results

[browser-results.json](browser-results.json) records every state and measurement. All of these passed:

- 12 states: light and dark, at 1440, 390, and 320 pixels wide, at 100% and 200% text. Reading text grew from 17px to 34px with no page overflow. Every button and summary was at least 44px tall.
- 44 role contrast pairs measured from browser-computed colors. The lowest text ratio is 4.73:1, and the lowest boundary or focus ratio is 4.10:1.
- Chromium's font inspector found custom glyphs for Atkinson Hyperlegible Next and Atkinson Hyperlegible Mono. Blocking the font files showed the fallback messages.
- Keyboard checks for the skip link, visible focus, the mode switch with Space, persistence after reload, the disclosure, code scrolling, and the reference link.
- The mode follows the system until the reader picks one, and the switch keeps working when storage is blocked. Without JavaScript the page stays readable in both system modes.
- User text-spacing overrides cause no page overflow. Direct `file://` use loads both fonts.

The screenshots in this folder show the specimen at 1440px and 390px, in both modes, at 100% and 200% text.

The Tailwind v4 path was not rerun for this change because no Tailwind compiler is installed on this host. The steps below still apply.

## Reproduce

```sh
PLAYWRIGHT_MODULE=/path/to/playwright CHROMIUM_PATH=/path/to/chromium \
  node tests/browser_internal_visual_style.cjs
```

The script opens a temporary loopback-only server, tests a complete installed copy, writes evidence here, and removes its temporary copy. It installs no tooling.

To test a compiled Tailwind v4 build, copy the skill's assets into a temporary project whose build can resolve `tailwindcss`. Include the specimen and this fixture in the compiler's source scan:

```html
<h1 class="text-4xl font-normal dark:underline"></h1>
<button class="bg-page p-8"></button>
<span class="font-sans text-success bg-success-tint"></span>
<code class="font-mono"></code>
```

Compile `assets/tailwind.css` to `compiled.css` beside the assets so the `./fonts/` URLs resolve. Then run the script with `TAILWIND_CSS=/path/to/compiled.css`.

## Limits

These checks cover headless Chromium on Linux, synthetic viewports, keyboard behavior, doubled root text size, and computed contrast. They do not cover real phones, Firefox, Safari, screen readers, or operating-system text enlargement.
