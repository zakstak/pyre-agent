# Internal visual reference

## Scope and selection

Use this reference for all UI and theming work without a specific product design system. This includes developer plans, review pages, reports, and ad hoc visual artifacts. Honor explicit task instructions first. Product-specific branding takes precedence. For a product with partial guidance, use compatible parts of this reference to fill gaps. Do not restyle established products to match the example.

This file owns the shared guidance. [../assets/tokens.css](../assets/tokens.css) is the single source of semantic design token values. The skill entrypoint selects this reference. This reference does not load the skill or other prompts.

## Confirmed decisions

- Use Atkinson Hyperlegible Next for reading text and Atkinson Hyperlegible Mono for code and technical text. Both fonts are chosen and bundled as upright variable fonts. System font stacks are fallbacks if a bundled font cannot load.
- Support dark and light modes with a keyboard-accessible control, visible state, and visible focus. Start with the system preference unless the reader has selected a mode.
- Keep character quiet and layouts uncluttered. Use short, literal headings that identify content. Omit marketing headings, ornamental subtitles, filler, and decoration that competes with the work.
- Give status colors consistent meanings and use them sparingly. Always pair status color with text. Separate neutral progress or pending decisions from success, warning, and failure.
- Let content determine the layout. Use readable prose widths, wider code or comparison areas when needed, and flexible sections. The example is a specimen, not a required dashboard or card template.
- Support readers who find dense text difficult. Use left-aligned prose, comfortable line height, clear paragraph spacing, concise sections, and ordinary casing. Avoid full justification, long italic passages, and text embedded in images. Preserve zoom and user text-spacing overrides. Do not claim that a font treats dyslexia or guarantees medical benefits.

Typography is confirmed. JetBrains Mono is not selected.

## Selected design direction

The current reference is Zak's supplied charcoal editor screenshot: quiet purple-gray layers, thin decorative separators, lavender focus and dusty pink primary actions. Both Atkinson fonts remain confirmed. The historical selection was theme 04 Margin notes (`moss`); its earlier violet–indigo palette and rail geometry are superseded by this explicit reference request. The banner remains undecided.

[reference-theme-contract.json](reference-theme-contract.json) preserves the complete supplied version 2 contract, SHA-256 `4cb5c21b3d08f297b1bd8c0a81916168307d452ac6e457670e5fab11d1418d27`. Dark source colors are exact screenshot values. The light companion and success role are derived; they are not screenshot evidence. tokens.css implements the contract's semantic palette. Preserve this distinction when extending it.

Use 17px reading text at 1.55 line height, 26px headings and 20px section headings, expressed in rem; 68ch prose and 1180px work measures, 8px fields/buttons and 10px quiet panels. Technical text must remain at least 14px and controls 44px. Let content determine layout rather than requiring rails or a dashboard. Keep shrinkable tracks, intrinsic nonbreaking technical identifiers and font-relative stacking/padding when text is enlarged on narrow phones. Preserve reading order and code scrolling.

## Contrast restrictions

The contract contains the full contrast matrix, including restricted pairs. Dark source borders are decorative separators; necessary control boundaries use control-border or functional-border. Source-muted text must not appear on overlay, input, subtle, highlight, message or sidebar selection fills. Use primary ink there. Status roles use surface backgrounds. The neutral status uses primary ink on raised. Do not claim every source pairing is accessible, silently alter source colors, or use a passing palette test as proof of every consumer's layout.

## Semantic tokens

Use the CSS custom properties in tokens.css for page and surface backgrounds, text, secondary text, borders, links, focus, and named status pairs. Typography, spacing, reading measure, corner radius, and control size are also owned there. Do not repeat palette values in HTML, component styles, Tailwind configuration, or prompts. If a needed semantic role is missing, add it at the source and verify both modes. Avoid anonymous color utilities for status.

Success means a verified successful result. Warning means a condition that needs attention. Danger means a failed result or destructive action. Pending choices and ordinary metadata use the neutral role. Status foregrounds use the handed-off success, warning, and error colors against the shared surface background. Neutral status uses primary text on raised. No extra status palette is invented.

## Browser consumption

For plain HTML, link [../assets/style.css](../assets/style.css). It imports tokens.css and fonts.css. Include [../assets/theme.js](../assets/theme.js) in the head before styles and provide the theme control shown in [../assets/reference.html](../assets/reference.html). The script applies the saved choice, catches unavailable storage, follows system changes while no choice is saved, and makes the native button operational. Without JavaScript, CSS follows the system theme and the manual button stays hidden.

For Tailwind v4, use [../assets/tailwind.css](../assets/tailwind.css) as a compiled CSS entry in the consuming project's existing build. It imports Tailwind, the same tokens, font declarations, and optional specimen component classes. The `@theme inline` aliases refer to semantic variables rather than repeating values. The `dark` variant follows `data-theme="dark"`. Semantic color utilities already change with the mode. Do not use a CDN runtime or add a parallel Tailwind v3 configuration. See the official [theme variable](https://tailwindcss.com/docs/theme) and [dark mode](https://tailwindcss.com/docs/dark-mode) references.

When copying assets, preserve their relative paths. A compiler may leave the font URL relative to its output rather than copy the font. Inspect the built CSS and deliver the referenced font at the resolved URL, or use the project's existing asset pipeline to rewrite it. The CSS uses `light-dark()` and `color-scheme` to keep each role's two values together. Target modern browsers, as required by Tailwind v4, and test the consuming environment. The example needs no build, hosting, or network access. Open reference.html directly for inspection. A local test server is optional and must stay local.

## Typography and fallback

Both bundled Atkinson upright fonts cover weights 200 through 800. Use weights 400 or 650 for ordinary reading and hierarchy. Code uses Atkinson Hyperlegible Mono. Avoid synthetic italics. The example reports each font's load success or fallback in the page. Verify actual rendered fonts in reading and technical text, not just font-family declarations. System fallbacks vary by device.

The reading font comes from [Google Fonts](https://github.com/google/fonts/tree/51303ca9e8ac9dcea7b12d307ba568fd0e6fcfca/ofl/atkinsonhyperlegiblenext). Its SHA-256 is `5a455d1cfa099b601ab70751bb9673e8fe1854dc4500c80e1a220d0d75e31745`. The technical font comes from [Google Fonts](https://github.com/google/fonts/tree/51303ca9e8ac9dcea7b12d307ba568fd0e6fcfca/ofl/atkinsonhyperlegiblemono). Its SHA-256 is `5ce8b1698d1ded7dff2178c1a3ad159470085a58ea239e8b2cb88f4fb4a6f646`. Keep [../assets/fonts/OFL.txt](../assets/fonts/OFL.txt) with the reading font and [../assets/fonts/atkinson-hyperlegible-mono-OFL.txt](../assets/fonts/atkinson-hyperlegible-mono-OFL.txt) with the technical font. These are required third-party font notices; project instructions and code use the single repository root MIT license. See [Braille Institute's font information](https://www.brailleinstitute.org/freefont/) for provenance.

## Validation for each output

Check phone and desktop in both modes with realistic content. At 200% text size, headings, controls, and content must remain readable without clipping or page-level horizontal scrolling. Wide code or tables may scroll within a labeled region. Also check narrow reflow and user text-spacing overrides. Use relative text sizes and no fixed text-container heights.

Use keyboard alone to reach the content, switch modes, follow links, and operate disclosures. Keep focus visible and control names clear. Check mode persistence when storage works and continued operation when storage fails. Confirm that no-JavaScript content remains readable. Respect reduced motion.

Measure text contrast against its actual background in both modes. Target WCAG AA ratios of at least 4.5:1 for ordinary text, 3:1 for large text, and 3:1 for necessary control boundaries and focus indicators. Check every status foreground against its paired background. Color alone must never carry a result. Automated checks support inspection; they do not establish complete accessibility certification.

Inspect font requests and rendered fonts. Test a missing-font case and show or disclose fallback. Verify every local reference and copy dependency, including font notices and compiled asset URLs. Report tested browsers, sizes, actual font results, and remaining limitations. Retest contrast and layout when the palette, theme treatment, or typography is revised.
