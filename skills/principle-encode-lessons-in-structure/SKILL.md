---
name: principle-encode-lessons-in-structure
description:
  "Use when you catch yourself writing the same instruction a second time, or
  notice a recurring correction. Encode the rule as a lint, metadata flag,
  runtime check, or script instead of more text."
metadata:
  version: "1.2.0"
---

# Encode Lessons in Structure

Encode recurring fixes in mechanisms (tools, code, metadata, automation) instead
of repeating textual instructions. Keep the mechanism within the task's scope
and authorized owner. A correction is evidence about the current work; it does
not authorize wider refactoring or maintenance of shared instructions or memory.

**Why:** Textual instructions are easy to miss. They require the reader to
notice, remember, and comply. Structural mechanisms (lint rules, metadata flags,
runtime checks, automation scripts) enforce the rule without cooperation.

**Pattern:** When you catch yourself writing the same instruction a second time:

1. Ask: can this be a lint rule, a metadata flag, a runtime check, or a script?
2. If yes and the mechanism is in scope, cover the applicable entry paths and
   verify enforcement before removing a redundant directive
3. If the fix requires judgment, use the existing task notes or checkpoint to
   explain the decision. Propose shared guidance separately when needed

**Pick a mechanism that prevents the demonstrated mistake.** Prefer one owner
and a supported interface, then types, boundary checks, or a lint rule. The
[correct workflow](../correct/SKILL.md#fix-each-class-at-the-highest-level-that-works)
provides a broader repository correction pass when the operator requests it.

**Corollary:** Replace redundant agent directives with verified structural
enforcement. Retain documentation that explains the interface, preconditions,
configuration or recovery.

**Task feedback:**

- Distinguish a one-off failure from a recurring pattern using actual evidence.
- Apply a confirmed fix within the current task and verify affected behavior.
- Keep material evidence and unfinished work in the existing task checkpoint.
  Propose broader mechanisms without making them delivery prerequisites.
- Update persistent memory or shared instructions only when explicitly
  requested.

Do not equate recording a lesson with preventing the mistake. A structural fix
needs evidence that the old failure is rejected through the supported path.
