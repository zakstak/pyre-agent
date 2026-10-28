---
name: internal-visual-style
description:
  "Use for UI and theming work without a product design system, such as
  developer plans, review pages, reports, and ad hoc visual artifacts. Applies
  the shared internal visual reference. Product branding takes precedence."
metadata:
  version: "1.3.4"
---

# Internal visual style

Select the task's explicit visual instructions and existing product design
system first. For all UI and theming work without a specific product design
system, read [references/BRAND.md](references/BRAND.md) and use it as the shared
reference. If a product owns only part of the design, use the reference for
compatible gaps. Do not rebrand the product. Plain prose and code work without
visual output do not need this skill.

The reference owns the design guidance. [assets/tokens.css](assets/tokens.css)
owns semantic token values, and [assets/components.css](assets/components.css)
owns the shared components. Open the [component specimen](assets/reference.html)
before building browser output, or use
[assets/tailwind.css](assets/tailwind.css) for compiled Tailwind v4. Adapt the
layout to the content. Keep diagnostics, provenance, and caveats out of the
first screen.

Copy the complete folder when installing this skill. Its references, styles,
script, and chosen reading and technical fonts are bundled. No skill depends on
it, but the review-canvas package reads `assets/` from this folder at build
time. Validate the resulting artifact using the checks in the reference and
disclose any unverified behavior or font fallback.
