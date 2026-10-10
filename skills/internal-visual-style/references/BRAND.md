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

Zak selected live playground theme 04, "Margin notes", with legacy style ID `moss`. The palette direction is a violet–indigo mix. Both Atkinson fonts remain confirmed.

The supplied published baseline is themeSite source `d90c38ebb6f38efc2201c85aba031d060c4cf567`. This selection was handed into draft PR 17 on 2026-10-10. Identify the selection by this published baseline, name, and legacy ID. A newer unpublished theme 04 is not the selected baseline.

## Palette handoff and remaining choices

The verified palette handoff is `violet-indigo` in `dist/palettes.json` from theme Site project `appgprj_6ac9171661708191839eff184cb7435f`, published source `4dddf282d1b12f77c7ce08fe32abff4bb2ae5486`. The handed-off palettes.json SHA-256 is `d76fb1b976cf9209f024c865ad06fa408dd4d9416d2c0037569c9ac2af83ec98`. This is the published refinement of the earlier `8518e3cbc7f056db634140efc4b8499686bad7be` handoff, with the same selected values. Tokens.css now implements those exact light and dark values. Focus uses accent-secondary. The handoff authorizes palette implementation; it does not depend on another manual color preview or on the Site selector's separately tracked bugs.

The specimen uses the selected legacy Margin notes geometry: 17px reading size expressed in rem, 70ch reading measure, 1030px work measure expressed in rem, 38px section spacing expressed in rem, 3px corner radius expressed in rem, a left rail, and inset evidence. The inspected legacy `moss` fixture agrees with that identity. The ordinal theme number alone must not select a replacement style.

The banner remains undecided and is not implemented. The specimen is a content-driven example, not a required layout. Do not invent an approved banner or redesign the selected direction while completing the review workflow.

## Semantic tokens

Use the CSS custom properties in tokens.css for page and surface backgrounds, text, secondary text, borders, links, focus, and named status pairs. Typography, spacing, reading measure, corner radius, and control size are also owned there. Do not repeat palette values in HTML, component styles, Tailwind configuration, or prompts. If a needed semantic role is missing, add it at the source and verify both modes. Avoid anonymous color utilities for status.

Success means a verified successful result. Warning means a condition that needs attention. Danger means a failed result or destructive action. Pending choices and ordinary metadata use the neutral role. Status foregrounds use the handed-off success, warning, and error colors against the shared surface background. Neutral status uses muted text on raised. No extra status palette is invented.

## Browser consumption

For plain HTML, link [../assets/style.css](../assets/style.css). It imports tokens.css and fonts.css. Include [../assets/theme.js](../assets/theme.js) in the head before styles and provide the theme control shown in [../assets/reference.html](../assets/reference.html). The script applies the saved choice, catches unavailable storage, follows system changes while no choice is saved, and makes the native button operational. Without JavaScript, CSS follows the system theme and the manual button stays hidden.

For Tailwind v4, use [../assets/tailwind.css](../assets/tailwind.css) as a compiled CSS entry in the consuming project's existing build. It imports Tailwind, the same tokens, font declarations, and optional specimen component classes. The `@theme inline` aliases refer to semantic variables rather than repeating values. The `dark` variant follows `data-theme="dark"`. Semantic color utilities already change with the mode. Do not use a CDN runtime or add a parallel Tailwind v3 configuration. See the official [theme variable](https://tailwindcss.com/docs/theme) and [dark mode](https://tailwindcss.com/docs/dark-mode) references.

When copying assets, preserve their relative paths. A compiler may leave the font URL relative to its output rather than copy the font. Inspect the built CSS and deliver the referenced font at the resolved URL, or use the project's existing asset pipeline to rewrite it. The CSS uses `light-dark()` and `color-scheme` to keep each role's two values together. Target modern browsers, as required by Tailwind v4, and test the consuming environment. The example needs no build, hosting, or network access. Open reference.html directly for inspection. A local test server is optional and must stay local.

## Typography and fallback

Both bundled Atkinson upright fonts cover weights 200 through 800. Use weights 400, 600, or 700 for ordinary reading and hierarchy. Code uses Atkinson Hyperlegible Mono. Avoid synthetic italics. The example reports each font's load success or fallback in the page. Verify actual rendered fonts in reading and technical text, not just font-family declarations. System fallbacks vary by device.

The reading font comes from [Google Fonts](https://github.com/google/fonts/tree/51303ca9e8ac9dcea7b12d307ba568fd0e6fcfca/ofl/atkinsonhyperlegiblenext). Its SHA-256 is `5a455d1cfa099b601ab70751bb9673e8fe1854dc4500c80e1a220d0d75e31745`. The technical font comes from [Google Fonts](https://github.com/google/fonts/tree/51303ca9e8ac9dcea7b12d307ba568fd0e6fcfca/ofl/atkinsonhyperlegiblemono). Its SHA-256 is `5ce8b1698d1ded7dff2178c1a3ad159470085a58ea239e8b2cb88f4fb4a6f646`. Keep [../assets/fonts/OFL.txt](../assets/fonts/OFL.txt) with the reading font and [../assets/fonts/atkinson-hyperlegible-mono-OFL.txt](../assets/fonts/atkinson-hyperlegible-mono-OFL.txt) with the technical font. These are required third-party font notices; project instructions and code use the single repository root MIT license. See [Braille Institute's font information](https://www.brailleinstitute.org/freefont/) for provenance.

## Validation for each output

Check phone and desktop in both modes with realistic content. At 200% text size, headings, controls, and content must remain readable without clipping or page-level horizontal scrolling. Wide code or tables may scroll within a labeled region. Also check narrow reflow and user text-spacing overrides. Use relative text sizes and no fixed text-container heights.

Use keyboard alone to reach the content, switch modes, follow links, and operate disclosures. Keep focus visible and control names clear. Check mode persistence when storage works and continued operation when storage fails. Confirm that no-JavaScript content remains readable. Respect reduced motion.

Measure text contrast against its actual background in both modes. Target WCAG AA ratios of at least 4.5:1 for ordinary text, 3:1 for large text, and 3:1 for necessary control boundaries and focus indicators. Check every status foreground against its paired background. Color alone must never carry a result. Automated checks support inspection; they do not establish complete accessibility certification.

Inspect font requests and rendered fonts. Test a missing-font case and show or disclose fallback. Verify every local reference and copy dependency, including font notices and compiled asset URLs. Report tested browsers, sizes, actual font results, and remaining limitations. Retest contrast and layout when the palette, theme treatment, or typography is revised.
