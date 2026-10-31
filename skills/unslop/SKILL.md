---
name: unslop
description:
  "Use when editing or reviewing prose for AI writing patterns, and whenever
  technical-writing is active. Removes the patterns while preserving meaning and
  intended tone."
metadata:
  version: "1.1.0"
---

# Unslop

Remove writing patterns that obscure meaning or make prose sound formulaic.
Preserve the author's meaning, intended tone, exact quotations, code syntax, and
source content requested verbatim. A pattern is a cue to inspect a sentence, not
a reason to change its meaning or expand the task.

For an ordinary edit:

- Replace filler, inflated vocabulary, invented jargon, and vague claims with
  concrete facts and familiar words.
- State the point directly. Remove stock praise, rhetorical contrasts, generic
  conclusions, and repeated restatements.
- Use complete sentences with clear actors. Split dense sentences, keep useful
  detail, and avoid fragments that make the reader decode the result.
- Keep formatting and punctuation in service of readability. Respect established
  templates. Leave a sentence alone when a style rule would make it worse.

For a dedicated prose review or a specific recurring pattern, consult the
[pattern reference](references/patterns.md). Its numbered rules remain stable
for callers that cite them. Routine technical writing does not require reading
all of the examples.
