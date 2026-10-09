# Internal visual reference

## Scope and selection

Use this reference for all UI and theming work without a specific product design system. This includes developer plans, review pages, reports, and ad hoc visual artifacts. Honor explicit task instructions first. Product-specific branding takes precedence. For a product with partial guidance, use compatible parts of this reference to fill gaps. Do not restyle established products to match the example.

This file owns the shared guidance. [../assets/tokens.css](../assets/tokens.css) is the single source of semantic design token values. The skill entrypoint selects this reference. This reference does not load the skill or other prompts.

## Confirmed decisions

- Use Atkinson Hyperlegible Next for reading text. The example bundles the upright variable font. Technical text can use the system monospace fallback until a mono is selected.
- Support dark and light modes with a keyboard-accessible control, visible state, and visible focus. Start with the system preference unless the reader has selected a mode.
- Keep character quiet and layouts uncluttered. Use short, literal headings that identify content. Omit marketing headings, ornamental subtitles, filler, and decoration that competes with the work.
- Give status colors consistent meanings and use them sparingly. Always pair status color with text. Separate neutral progress or pending decisions from success, warning, and failure.
- Let content determine the layout. Use readable prose widths, wider code or comparison areas when needed, and flexible sections. The example is a specimen, not a required dashboard or card template.
- Support readers who find dense text difficult. Use left-aligned prose, comfortable line height, clear paragraph spacing, concise sections, and ordinary casing. Avoid full justification, long italic passages, and text embedded in images. Preserve zoom and user text-spacing overrides. Do not claim that a font treats dyslexia or guarantees medical benefits.

## Unresolved choices

The final palette, theme treatment, and banner are not selected. The values in tokens.css are provisional accessible examples that make structure and behavior reviewable. No banner is implemented. Do not present these examples as approved brand colors or a finished theme.

The technical mono is undecided. JetBrains Mono is a candidate only. It is neither bundled nor declared as the selected font. The example uses `ui-monospace` with platform fallbacks and labels that choice explicitly. Changing the mono later requires a token update, font loading and licensing checks, and another layout pass.

## Semantic tokens

Use the CSS custom properties in tokens.css for page and surface backgrounds, text, secondary text, borders, links, focus, and named status pairs. Typography, spacing, reading measure, corner radius, and control size are also owned there. Do not repeat palette values in HTML, component styles, Tailwind configuration, or prompts. If a needed semantic role is missing, add it at the source and verify both modes. Avoid anonymous color utilities for status.

Success means a verified successful result. Warning means a condition that needs attention. Danger means a failed result or destructive action. Pending choices and ordinary metadata use the neutral role. Status tint backgrounds are only for compact status text. They do not color whole sections.

## Browser consumption

For plain HTML, link [../assets/style.css](../assets/style.css). It imports tokens.css and fonts.css. Include [../assets/theme.js](../assets/theme.js) in the head before styles and provide the theme control shown in [../assets/reference.html](../assets/reference.html). The script applies the saved choice, catches unavailable storage, follows system changes while no choice is saved, and makes the native button operational. Without JavaScript, CSS follows the system theme and the manual button stays hidden.

For Tailwind v4, use [../assets/tailwind.css](../assets/tailwind.css) as a compiled CSS entry in the consuming project's existing build. It imports Tailwind, the same tokens, font declarations, and optional specimen component classes. The `@theme inline` aliases refer to semantic variables rather than repeating values. The `dark` variant follows `data-theme="dark"`. Semantic color utilities already change with the mode. Do not use a CDN runtime or add a parallel Tailwind v3 configuration. See the official [theme variable](https://tailwindcss.com/docs/theme) and [dark mode](https://tailwindcss.com/docs/dark-mode) references.

When copying assets, preserve their relative paths. A compiler may leave the font URL relative to its output rather than copy the font. Inspect the built CSS and deliver the referenced font at the resolved URL, or use the project's existing asset pipeline to rewrite it. The CSS uses `light-dark()` and `color-scheme` to keep each role's two values together. Target modern browsers, as required by Tailwind v4, and test the consuming environment. The example needs no build, hosting, or network access. Open reference.html directly for inspection. A local test server is optional and must stay local.

## Typography and fallback

The bundled Atkinson Hyperlegible Next upright font covers weights 200 through 800. Use weights 400, 600, or 700 for ordinary reading and hierarchy. Avoid synthetic italics. Code uses the provisional system mono stack. The example reports reading font load success or fallback in the page. Verify actual font loading in the target output, not just a font-family declaration. System mono appearance varies by device.

The reading font comes from [Google Fonts](https://github.com/google/fonts/tree/51303ca9e8ac9dcea7b12d307ba568fd0e6fcfca/ofl/atkinsonhyperlegiblenext). Its SHA-256 is `5a455d1cfa099b601ab70751bb9673e8fe1854dc4500c80e1a220d0d75e31745`. Keep [../assets/fonts/OFL.txt](../assets/fonts/OFL.txt) with the redistributed font. That is the font's required third-party notice; project instructions and code use the single repository root MIT license. See [Braille Institute's font information](https://www.brailleinstitute.org/freefont/) for provenance.

## Validation for each output

Check phone and desktop in both modes with realistic content. At 200% text size, headings, controls, and content must remain readable without clipping or page-level horizontal scrolling. Wide code or tables may scroll within a labeled region. Also check narrow reflow and user text-spacing overrides. Use relative text sizes and no fixed text-container heights.

Use keyboard alone to reach the content, switch modes, follow links, and operate disclosures. Keep focus visible and control names clear. Check mode persistence when storage works and continued operation when storage fails. Confirm that no-JavaScript content remains readable. Respect reduced motion.

Measure text contrast against its actual background in both modes. Target WCAG AA ratios of at least 4.5:1 for ordinary text, 3:1 for large text, and 3:1 for necessary control boundaries and focus indicators. Check every status foreground against its paired tint. Color alone must never carry a result. Automated checks support inspection; they do not establish complete accessibility certification.

Inspect font requests and rendered fonts. Test a missing-font case and show or disclose fallback. Verify every local reference and copy dependency, including font notices and compiled asset URLs. Report tested browsers, sizes, actual font results, and remaining limitations. Retest contrast and layout when provisional colors, theme treatment, or mono change.
