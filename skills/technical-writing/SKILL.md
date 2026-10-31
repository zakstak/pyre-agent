---
name: technical-writing
description:
  "Use when writing or reviewing docs, RFCs, readmes, PR descriptions, or commit
  messages. Keep routine edits concise; use detailed guidance for substantial
  documentation."
metadata:
  version: "1.2.0"
---

# Technical writing

Write for a reader who needs to understand the change or complete a task.
Preserve the requested meaning, product requirements, document structure, and
established templates. Keep code, expected output, quotations, URLs, and symbol
names exact unless changing them is part of the task.

For routine edits, commit messages, and PR descriptions:

- Lead with the concrete problem and resulting behavior. Include validation and
  any material limitation. Scale detail to the change.
- Use familiar words, active verbs, and specific names from the codebase. Remove
  filler and invented jargon. Mix sentence lengths when it improves clarity.
- Keep instructions actionable and reference facts accurate. Separate a
  recommendation from an established requirement.
- Apply the short [unslop guidance](../unslop/SKILL.md). Preserve meaning when
  correcting style; leave a sentence alone when a rule would make it worse.

For substantial documentation or a question about document structure, consult
relevant sections of the [full writing guide](references/writing-guide.md). It
covers Diátaxis modes, sentence construction, and worked examples. Routine
changes do not require loading the full guide or every pattern reference.
