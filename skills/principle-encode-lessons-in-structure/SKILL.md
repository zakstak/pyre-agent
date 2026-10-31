---
name: principle-encode-lessons-in-structure
description:
  "Use when you catch yourself writing the same instruction a second time, or
  notice a recurring correction. Encode the rule as a lint, metadata flag,
  runtime check, or script instead of more text."
metadata:
  version: "1.1.1"
---

# Encode Lessons in Structure

Encode recurring fixes in mechanisms (tools, code, metadata, automation) instead
of textual instructions. Keep the mechanism within the requested scope. A
correction does not authorize broader work.

**Why:** Textual instructions are easy to miss. They require the reader to
notice, remember, and comply. Structural mechanisms (lint rules, metadata flags,
runtime checks, automation scripts) enforce the rule without cooperation.

**Pattern:** When you catch yourself writing the same instruction a second time:

1. Ask: can this be a lint rule, a metadata flag, a runtime check, or a script?
2. If yes and in scope, wire the mechanism into every applicable entry path and
   verify it enforces the rule before removing a redundant agent directive
3. If no (requires judgment), explain the decision in the current task notes

**Pick the strongest mechanism.** When choosing an enforcement mechanism, read
[the ladder and proof rules in correct](../correct/SKILL.md#fix-each-class-at-the-highest-level-that-works).
Agents copy whatever the surrounding code already does, so a weaker guard
becomes the next template.

**Corollary:** Replace redundant agent directives with verified structural
enforcement. Retain documentation that explains the interface, preconditions,
configuration or recovery.

**Feedback loop:**

Apply corrections to the current task. For a recurring problem, add an in-scope
mechanism that prevents it. Propose broader skill or tooling changes separately.
Update persistent memory only when explicitly requested.
