# Internal visual reference

## Scope

Use this reference for UI and theming work that has no product design system. That includes developer plans, review pages, reports, and ad hoc visual artifacts. Explicit task instructions come first, then product branding. If a product owns part of its design, fill only the gaps from this reference and do not restyle the product.

[../assets/tokens.css](../assets/tokens.css) holds every color, type, spacing, and size value. [../assets/components.css](../assets/components.css) holds the shared components. [../assets/reference.html](../assets/reference.html) shows them together in both modes. This file explains how to use them.

## Principles

- Lead with the content. The first screen shows the title, the result, and the next action. Put coverage notes, provenance, and caveats in a disclosure or the footer.
- Keep the page quiet. Use the charcoal and violet layers and thin separators. Do not add gradients, shadows, blur, translucent text, or decoration.
- Show structure with spacing and type before boxes. Use a panel for one unit of work, such as a file or a form. Do not nest panels.
- Give each view one primary action. Use the default button for other actions and the quiet button for low-weight ones such as **Collapse all**.
- Put a control next to the thing it changes. A comment composer opens under the code it quotes, not in a fixed area elsewhere on the page.
- Do not show diagnostics as UI. Font-loading reports, internal IDs, and raw JSON belong in validation output unless the reader asked for them.
- Use short, literal headings and labels in sentence case. Write **Finish review**, not **Save and restore review workflow**.

## Color

Use roles, not hex values. Each role switches with the mode.

| Role | Token | Use |
| --- | --- | --- |
| Page | `--bg-page` | Page canvas and the app bar |
| Surface | `--bg-surface` | Panels and file cards |
| Raised | `--bg-raised` | Headers inside panels, buttons, comment cards |
| Code | `--bg-code` | Code, diffs, and text fields |
| Sidebar | `--pyre-sidebar` | Side navigation |
| Primary text | `--text-primary` | Body text and any text on a tinted fill |
| Secondary text | `--text-secondary` | Metadata, hints, and line numbers |
| Separator | `--separator` | Decorative lines around and between panels |
| Control border | `--border` | Boundaries of fields and buttons |
| Accent | `--pyre-accent`, `--link`, `--focus` | Links, focus rings, current item, comment affordances |
| Action | `--pyre-action` | The primary button only |
| Subtle | `--pyre-subtle` | Hover fills, callouts, and diff hunk rows |
| Status | `--status-success`, `--status-warning`, `--status-danger` | Results, paired with words |
| Diff tints | `--pyre-diff-addition`, `--pyre-diff-deletion` | Added and deleted diff rows |
| Selection | `--pyre-selection` | Selected text |

The dark source colors are exact values from Zak's reference screenshot. The light companion, the success role, and the `color-mix()` roles are derived. [reference-theme-contract.json](reference-theme-contract.json) records the source contract, SHA-256 `4cb5c21b3d08f297b1bd8c0a81916168307d452ac6e457670e5fab11d1418d27`, including its full contrast matrix. Keep the source and derived distinction when you extend the palette.

If you need a role that does not exist, add it to tokens.css and verify it in both modes. Derive it from existing roles with `color-mix()` where possible. Do not put color values in component CSS, HTML, or Tailwind configuration.

Some source pairs fail contrast. Secondary text must not sit on the overlay, input, subtle, highlight, message, or sidebar-selection fills. Switch it to primary text on those fills, including on hover. Status text sits on the surface fill. The neutral status uses primary text on the raised fill.

Status colors keep one meaning each. Success means a verified good result. Warning means something needs attention. Danger means a failure or a destructive action. Pending work and ordinary metadata use the neutral chip. Color never carries a result alone.

## Typography

| Style | Token | Size and weight | Use |
| --- | --- | --- | --- |
| Title | `--size-title` | 26px, 650 | One per page |
| Heading | `--size-heading` | 20px, 650 | Sections |
| Subheading | `--size-subheading` | 17px, 650 | Units inside a section |
| Body | `--size-reading` | 17px, 400, line height 1.55 | Prose |
| Small | `--size-small` | 15px, 400 or 600 | Labels, metadata, hints |
| Technical | `--size-technical` | 14px, Mono | Code, diffs, paths, hashes |

Atkinson Hyperlegible Next is the reading font. Atkinson Hyperlegible Mono is the technical font. Buttons and field labels use weight 600. Avoid synthetic italics and long italic passages. Set file paths, commit hashes, and commands in the technical font. Technical text never drops below 14px.

## Layout

- The spacing scale is `--space-1` through `--space-7`: 4, 8, 12, 16, 24, 32, and 48px.
- Prose stays within `--measure-reading` (68ch). Work areas stay within `--measure-work` (1180px).
- Chips use 6px corners. Controls and code use 8px. Panels use 10px.
- An app bar holds the page name on the left and global controls on the right, with the mode switch last. It sticks to the top on wide screens and scrolls away on phones.
- Use a sidebar only to move between many items, such as changed files. Hide it below 1024px.
- Long units, such as a file in a diff, can have a sticky header placed below the app bar.
- Phones get one column and 16px page padding. At 320px with enlarged text, padding shrinks through `clamp()` to recover reading width.

## Components

The classes below are in components.css. The specimen shows each one.

- **Buttons.** `button` is the default. `.primary` marks the one primary action. `.quiet` has no border or fill until hover. Every button is at least 44px tall. Toggle buttons use `aria-pressed`.
- **Mode switch.** `.theme-toggle` keeps the label **Dark mode** in a `.theme-label` span. The track and `aria-pressed` show the state. On phones the label is visually hidden but stays the accessible name, so the app bar fits one row. Load theme.js in the head.
- **Fields.** Text fields, selects, and text areas sit on the code fill with a control border. Give every field a label. A visually hidden label is acceptable only for a filter field whose placeholder states its purpose.
- **Panels.** `.panel` with `.panel-body` padding.
- **Chips.** `.chip` for metadata, with `.success`, `.warning`, and `.danger` variants that add a dot and a border.
- **Notices.** `.notice` explains a condition. Start it with a bold sentence that states the condition. Status variants color the edge and that sentence.
- **Disclosures.** `details` and `summary` get one chevron style everywhere. Use them for secondary material, not for the main content.
- **Code.** `.code-region` scrolls wide code inside a labeled, focusable region.
- **Diffs.** `.diff` is a unified table with old and new line numbers, tinted added and deleted rows, and a colored left edge. Row actions appear on hover and keyboard focus, and stay visible on touch screens.
- **Toasts.** Show one short message at a time in a polite live region at the bottom of the screen. Hide it after a few seconds unless it offers **Undo**.

## Interaction

- Hover uses the subtle fill. Keyboard focus always shows a 2px accent outline with a 2px offset.
- A disabled control uses secondary text on the surface fill. If the reason is not obvious, say it nearby.
- An empty state is one sentence that says what is missing and what to do next.
- Transitions last 150ms or less and only show state changes. Reduced motion turns them off.
- Every action works from the keyboard. Escape closes an inline editor and returns focus to the control that opened it. Ctrl+Enter submits a multi-line comment.

## Accessibility targets

- Text contrast is at least 4.5:1, or 3:1 for large text. Control boundaries and focus rings are at least 3:1.
- Targets are at least 44px. Dense row actions inside code and diffs are 24px, which meets the WCAG 2.2 AA target size. A 44px row would make a diff unreadable.
- Pages work at 320px wide and at 200% text without page-level horizontal scrolling. Wide code and tables scroll inside labeled regions.
- Zoom and user text-spacing overrides keep working. Prose is left-aligned with ordinary casing. Do not claim that a font treats dyslexia.

## Browser use

For plain HTML, link [../assets/style.css](../assets/style.css). It imports tokens.css, fonts.css, and components.css. Include [../assets/theme.js](../assets/theme.js) in the head before the styles and add the mode switch shown in reference.html. The script applies a saved choice, follows the system while no choice is saved, and keeps working when storage is unavailable. Without JavaScript, CSS follows the system mode and the switch stays hidden.

For Tailwind v4, use [../assets/tailwind.css](../assets/tailwind.css) as an entry in the consumer's existing build. It imports Tailwind, the tokens, the font declarations, and components.css as a components layer, so utilities override component defaults. The `@theme inline` aliases point at the semantic variables. The `dark` variant follows `data-theme="dark"`. Do not use the browser CDN runtime or add a Tailwind v3 configuration. See the official [theme variable](https://tailwindcss.com/docs/theme) and [dark mode](https://tailwindcss.com/docs/dark-mode) references.

Keep relative paths when you copy the assets. A compiler can leave the font URL relative to its output. Inspect the built CSS and serve the font at the resolved URL. Offline single-file artifacts, such as the PR review canvas, embed the tokens, components, and fonts directly. The CSS uses `light-dark()`, `color-mix()`, and container query units, so target current browsers.

## Fonts

Both bundled upright variable fonts cover weights 200 through 800. System font stacks are the fallback if a bundled font cannot load.

The reading font comes from [Google Fonts](https://github.com/google/fonts/tree/51303ca9e8ac9dcea7b12d307ba568fd0e6fcfca/ofl/atkinsonhyperlegiblenext). Its SHA-256 is `5a455d1cfa099b601ab70751bb9673e8fe1854dc4500c80e1a220d0d75e31745`. The technical font comes from [Google Fonts](https://github.com/google/fonts/tree/51303ca9e8ac9dcea7b12d307ba568fd0e6fcfca/ofl/atkinsonhyperlegiblemono). Its SHA-256 is `5ce8b1698d1ded7dff2178c1a3ad159470085a58ea239e8b2cb88f4fb4a6f646`. Keep [../assets/fonts/OFL.txt](../assets/fonts/OFL.txt) with the reading font and [../assets/fonts/atkinson-hyperlegible-mono-OFL.txt](../assets/fonts/atkinson-hyperlegible-mono-OFL.txt) with the technical font. Ship both notices with any artifact that embeds the fonts. See [Braille Institute's font information](https://www.brailleinstitute.org/freefont/) for provenance.

## Validate each output

1. Look at real screenshots at 1440px, 390px, and 320px wide, in both modes, at 100% and 200% text. Passing checks do not prove that a page looks right.
2. Use the keyboard alone to reach the content, switch modes, open disclosures, and complete the main task. Check that focus stays visible.
3. Measure text contrast against the rendered background in both modes, including derived fills such as diff tints.
4. Inspect the rendered fonts, not only the `font-family` declarations. Test a missing-font case.
5. Confirm that the page makes no external requests and that every local reference resolves.
6. Report the browsers, sizes, and font results you tested, and any limits.
