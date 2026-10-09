# Internal visual style validation

Checked 2026-10-09 on Zak's Linux workstation. This is a draft structure and implementation review. Atkinson Hyperlegible Next and Atkinson Hyperlegible Mono are chosen. The palette, theme treatment, and banner remain undecided.

## Results

- Skill Creator's `quick_validate.py`: PASS. JavaScript syntax checks and `git diff --check`: PASS.
- Plain HTML and compiled Tailwind v4: PASS in Chromium 152.0.7977.82 using existing Playwright. Each path passed 12 states: light and dark, widths 1440, 390, and 320 CSS pixels, at 100% and 200% text. Reading text increased from 18px to 36px. No page overflow occurred. Wide code remained locally scrollable.
- Each path checked 28 contrast pairs. Lowest ordinary text or status ratio: 5.91:1. Lowest necessary border or focus ratio: 4.01:1. Values came from browser-computed colors in each mode.
- Chromium's rendered-font inspection confirmed custom glyphs for both Atkinson Hyperlegible Next and Atkinson Hyperlegible Mono. Both bundled files' SHA-256 values match the pinned Google Fonts sources documented in the reference. The Mono variable font exposes the internal family name Atkinson Hyperlegible Mono ExtraLight to Chromium's font inspector; its CSS family is Atkinson Hyperlegible Mono, at weight 400. Missing font requests produced separate visible fallback messages. Direct file use loaded both fonts and operated the toggle without a server.
- Keyboard checks passed for skip navigation, visible focus, dark-mode state, Space activation, persistence after reload, disclosure, code scrolling, and the reference link. System changes applied before a manual choice. Blocked storage did not break the toggle. No-JavaScript pages remained readable in both system modes. User text-spacing overrides caused no page overflow. Reduced-motion emulation did not break mode changes.
- The complete skill was copied to a temporary directory without sibling skills before testing. All its local Markdown, HTML, CSS, script, and font references resolved. The normal example made no external requests or failed asset requests and had no page script errors.
- Tailwind CSS 4.3.0 compiled the adapter in temporary tooling, with no repository package manifest or global installation. Real browser assertions confirmed semantic utility colors/fonts and `dark:underline`. `text-4xl font-normal` and `bg-page p-8` overrode the specimen heading and button defaults.

The primary author visually inspected desktop, phone, and enlarged-text screenshots. Final screenshots include the visible mode state. Evidence is in [browser-results.json](browser-results.json), [tailwind-results.json](tailwind-results.json), and the PNGs in this directory. The screenshots contain only the fictional specimen.

## Independent review

An independent agent was explicitly requested with model `gpt-6.1-sol`. The initial review found one P2: unlayered specimen CSS could override Tailwind utilities. The fix imports specimen styles into `layer(components)`. The reviewer inspected the correction and the passing compiled utility checks and reported no unresolved findings. The same independent reviewer inspected the confirmed Mono update and refreshed evidence. A P3 screenshot-state mismatch in the test was fixed by selecting themes through the actual toggle and checking the visible label and ARIA state. The reviewer confirmed the fix and reported no unresolved findings. The review did not independently rerun the suites. The exact model was requested through the harness; underlying service routing was not independently verified.

Curated imported skills, global instructions, and the project root license were unchanged. Root README changes are limited to discovering this reference. Root BRAND.md is a locator; the maintained reference and all implementation dependencies live in the installable skill folder. Both bundled fonts retain their required OFL notices under assets/fonts; there is no per-skill project README or MIT LICENSE.

## Reproduce

Use an already available Playwright module and Chromium. Set paths for the host running the command:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright CHROMIUM_PATH=/path/to/chromium \
  node tests/browser_internal_visual_style.cjs
```

The script opens a temporary loopback-only server, tests a complete installed copy, writes evidence here, and removes its temporary copy and server. Some sandboxes require permission for loopback listening and browser startup. It installs no tooling.

To test a compiled Tailwind v4 build, copy the skill's assets into a temporary project whose existing build can resolve `tailwindcss`. Include the specimen and this utility fixture in the compiler's source scan:

```html
<h1 class="text-4xl font-normal dark:underline"></h1>
<button class="bg-page p-8"></button>
<span class="font-sans text-success bg-success-tint"></span>
<code class="font-mono"></code>
```

Compile assets/tailwind.css to compiled.css with that project's Tailwind v4 CLI. Keep compiled.css beside the assets so both `./fonts/` URLs resolve. Then run:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright CHROMIUM_PATH=/path/to/chromium \
  TAILWIND_CSS=/path/to/compiled.css node tests/browser_internal_visual_style.cjs
```

If automatic source detection does not include the fixture, add an `@source` directive in the temporary entry. The validation fixture is only a compiler input, not a prescribed layout.

## Limits

These checks cover Chromium on Linux, synthetic viewports, keyboard behavior, doubled root text size, and computed contrast. They do not establish real phone, Firefox, Safari, screen-reader, operating-system text enlargement, or complete accessibility qualification. No agent-provider discovery session or global skill installation was activated. Automatic skill selection depends on the provider and its configured skill directories.

The CSS uses modern `light-dark()` and `color-scheme`. Tailwind's modern browser requirements apply to the compiled path. Verify target browsers when adapting the reference. The compiler may leave relative font URLs; the consumer must deliver the font at the output's resolved path. System font fallbacks vary by platform. Revalidate when the unresolved palette, theme, or banner decisions change, or when typography is revised.
