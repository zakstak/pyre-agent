---
name: principle-fix-root-causes
description:
  "Use when debugging. Trace each symptom to its root cause and fix it there;
  reproduce first, ask why until you reach it, resist nil-check guards that
  silence crashes."
metadata:
  version: "1.0.3"
---

# Fix Root Causes

When debugging, do not fix symptoms. Trace every problem to its root cause and
fix it there.

**Why:** Symptom fixes accumulate. Each workaround makes the system harder to
reason about, and the real bug remains. Root-cause fixes are slower upfront but
reduce total debugging time.

**Pattern:**

- Reproduce first
- Ask "why" until you hit the root cause
- Do not add guards to silence a crash. A nil check that hides a crash is a
  symptom fix. A guard is the fix only when it validates input or state at a
  boundary
- If a workaround needs a paragraph-long comment to justify it, the code is
  wrong (fix the code, not the comment)
- Search for related occurrences to establish impact. Fix the affected paths
  needed for the requested outcome; propose wider work separately
- When stuck, instrument. Don't guess (add logging, read the actual error)

**Restart bugs: suspect state before code**

When something "fails after restart," suspect stale persistent state first:
config files, caches, lock files, serialized state. If clearing a state file
restores behavior, prioritize state validation as the fix.
