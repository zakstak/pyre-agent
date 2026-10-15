---
name: internal-visual-style
description:
  Apply the shared internal visual reference to UI and theming work without a
  specific product design system, including developer plans, review pages,
  reports, and ad hoc visual artifacts. Product-specific branding takes
  precedence.
metadata:
  version: "1.3.0"
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
script, and chosen reading and technical fonts are bundled. It requires no
sibling skills or external service. Validate the resulting artifact using the
checks in the reference and disclose any unverified behavior or font fallback.
