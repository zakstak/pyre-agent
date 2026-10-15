---
name: principle-type-system-discipline
description:
  "Use when designing types, reviewing a function signature, or writing code in
  a statically-typed language. Make illegal states unrepresentable, brand
  primitives, parse external data at boundaries, never lie to the compiler,
  exhaust variants."
metadata:
  version: "1.1.0"
---

# Type System Discipline

The type checker is a proof assistant. Use it to rule out impossible states,
mismatched primitives, and unhandled variants before the code runs. A case the
types let you ignore becomes a runtime failure the compiler could have stopped.
Prefer defining errors and special cases out of existence over adding handlers.

Applies to any typed language. The
[typescript-best-practices](../typescript-best-practices/SKILL.md) skill grounds
it in syntax, and its
[patterns reference](../typescript-best-practices/references/patterns.md) holds
the worked examples.

**The patterns:**

- **Make illegal states unrepresentable.** Model variants as a sum type, not a
  bag of optional fields where contradictory combinations compile. If a bug
  forces the question "can this combination actually happen?", the type is too
  loose.
- **Build types up, do not carve them down.** Construct the type from the values
  you want instead of restricting a looser type with checks. A non-empty list is
  a head plus a rest. A valid time range is a start plus a duration.
- **Brand semantic primitives.** `UserId` and `OrderId` are strings underneath
  and must not be interchangeable. Validate once at creation, trust the type
  downstream.
- **External data is untyped until parsed.** Payloads, JSON, CLI args, config,
  environment variables, and database rows pass through a parse function at the
  boundary. See the
  [boundary-discipline principle](../principle-boundary-discipline/SKILL.md).
- **Don't lie to the type system.** An unchecked cast or an assertion that skips
  validation hides a runtime failure. If the compiler can't prove a fact, prove
  it by validating, narrowing, or refining the model, or treat the cast as a
  hazard.
- **Make exhaustive matching the compiler's job where it can be.** For a closed
  sum type, compilation must fail when a new variant lacks a case. Where the
  toolchain cannot close variants, such as Go type switches, raise an explicit
  unexpected-case error and test the known variants. Do not claim what the
  compiler does not check.
- **Derive types from authoritative schemas.** When a protocol buffer, OpenAPI
  spec, GraphQL schema, migration, or token file defines a shape, derive the
  type from it. See the
  [encode-lessons-in-structure principle](../principle-encode-lessons-in-structure/SKILL.md).
- **Strengthen a type only where it removes an invalid case.** A "should never
  happen" throw or a plausible but wrong result marks a type that is too weak;
  push that check into the type. A check that handles modeled absence is
  ordinary case handling; keep it.
- **Prefer total functions.** `sum` of an empty list is 0, so it takes the plain
  list. `head` of an empty list has no answer, so it demands the non-empty one.
  The type's job is to track the cases each use site must handle, not to
  describe the data as precisely as possible.

**The tests:**

- "Do mutually exclusive states need a comment saying which fields may coexist?"
  Model them as a sum type.
- "Do two arguments share a primitive type but mean different things?" Brand
  them.
- "Where did this `any`, this cast, this `assertNotNull` come from?" Trace the
  unchecked input to its boundary and validate there.
- "If a variant is added next month, will the compiler say where to add a case?"
  Require that where the toolchain supports it.
- "Is this type duplicating a shape another file owns?" Derive instead.
- "Does strengthening this type remove an invalid case, or only add precision?"
  If only precision, keep the plain type.

**The idiom per language:**

| Idea             | TypeScript                   | Rust                | Swift                      | Kotlin and Scala             | Haskell and OCaml                   |
| ---------------- | ---------------------------- | ------------------- | -------------------------- | ---------------------------- | ----------------------------------- |
| Sum types        | Discriminated union          | Enum with payloads  | Enum with payloads         | Sealed class                 | Algebraic data type                 |
| Brands           | Branded intersection         | Newtype             | Nominal wrapper struct     | Value class                  | Phantom type                        |
| Exhaustive match | `never` binding in `default` | `match` without `_` | `switch` without `default` | Kotlin `when`, Scala `match` | Incomplete-pattern warning as error |
