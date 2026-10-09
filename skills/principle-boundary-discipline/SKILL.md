---
name: principle-boundary-discipline
description: "Apply when wiring validation, error handling, or framework adapters. Concentrate guards at system boundaries (CLI, config, network, external APIs); trust validated invariants and keep business logic in pure functions."
---

# Boundary Discipline

Place validation, type narrowing, and error handling at system boundaries. Trust established invariants inside a validated boundary. Validate again when data crosses another boundary or mutation can invalidate those invariants. Business logic lives in pure functions. The shell is thin and mechanical.

**Why:** Scattered validation is noisy, redundant, and gives a false sense of safety. Keep logic out of framework wiring so it can be tested without the framework.

**The pattern:**
- **At boundaries** (CLI args, config files, external APIs, network protocols): validate, return errors, handle defensively.
- **Inside the system:** typed data and error propagation, without redundant validation of invariants that still hold. Static types alone do not validate runtime input or prevent mutation through aliases.
- **Across the boundary.** Expose domain concepts, not the boundary's private representation. Keep general-purpose mechanism inside and special-purpose policy at the edge.

**Applications:**

Validation and error handling:
- Validate config syntax and self-contained invariants while parsing. Check environment-dependent constraints at the boundary where their context becomes available
- Parse raw data into domain types at the boundary
- Do not re-export transport, storage, framework, or wire types through the public surface
- No redundant nil checks deep in call chains if the boundary already validated

Code organization:
- Business logic in pure functions with no framework dependencies
- Parse functions: pure transforms from raw bytes to typed state
- Prompt construction: structured state in, string out
- Scoring and assessment: pure transforms from state to results

**The tests:**
- "Is this data crossing a system boundary, or has mutation invalidated an established invariant?" Validate those cases; skip only redundant checks of invariants that still hold.
- "Can this be a pure function that the shell just calls?" If yes, extract it.
