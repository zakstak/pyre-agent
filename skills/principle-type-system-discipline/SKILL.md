---
name: principle-type-system-discipline
description:
  "Apply when designing types, reviewing a function signature, or writing code
  in any statically-typed language. Make illegal states unrepresentable, brand
  semantic primitives, parse external data at boundaries, refuse to lie to the
  compiler, exhaust variants, derive from authoritative schemas."
metadata:
  version: "1.0.1"
---

# Type System Discipline

The type checker is a proof assistant. Use it to eliminate impossible states,
mismatched primitives, and unhandled variants at compile time. A case the types
let you ignore becomes a runtime failure the compiler could have stopped. Prefer
defining errors and special cases out of existence over proliferating handlers.
Unrepresentable states, total functions, and interface redesign (the patterns
below) are the tools.

Applies to any typed language. Skills like
[typescript-best-practices](../typescript-best-practices/SKILL.md) ground it in
specific syntax.

**The patterns:**

- **Make illegal states unrepresentable.** Model variants as sum types:
  discriminated unions in TypeScript, enums with payloads in Rust/Swift, sealed
  classes or interfaces in Kotlin, sealed classes in Scala, ADTs in
  Haskell/OCaml. Don't model state as a bag of optional fields where
  contradictory combinations compile. A subtle anti-pattern:
  `{ completed: boolean; completedAt?: Date }` admits
  `completed: true; completedAt: undefined`, which is meaningless. Derive the
  boolean from a single source like `completedAt !== undefined` for the optional
  timestamp, or model the variants explicitly as
  `{ kind: 'open'; at?: never } | { kind: 'done'; at: Date }`. The `never` field
  rejects a conflicting timestamp even when the object arrives through a typed
  variable; raw runtime input still needs validation. If a bug forces the
  question "wait, can this combination actually happen?", the type is too loose.
- **Types are constructions, not restrictions.** Build the type up from the
  values you want instead of carving them out of a looser type with checks. The
  invariant that seems to need a refinement type is usually a construction away.
  A non-empty list is a head plus a rest, not a list with a length check. A
  valid time range is a start plus a duration, not two timestamps you must keep
  ordered. No representation is privileged. A list of pairs is an even-length
  list if you interpret it that way, so choose the shape that cannot build the
  illegal value and expose the interface callers need on top.
- **Brand semantic primitives.** `UserId` and `OrderId` are strings underneath
  but should not be interchangeable. Newtypes in Rust, nominal wrapper structs
  in Swift, value classes in Kotlin, phantom types in Haskell, branded
  intersections in TypeScript. Validate once at creation, trust the type
  downstream.
- **External data is untyped until parsed.** RPC payloads, JSON, IPC messages,
  CLI args, config files, environment variables, database rows. Have a parse
  function at every boundary that turns unstructured input into the typed model.
  See the
  [boundary-discipline principle](../principle-boundary-discipline/SKILL.md) for
  where to put validation.
- **Don't lie to the type system.** Unchecked casts, unsafe coercions, and
  assertion functions that bypass validation can hide runtime failures. If the
  compiler can't prove a fact, prove it (validate, narrow, refine the model) or
  accept that the cast is a hazard. A TypeScript phantom brand may need a
  localized assertion in the validating constructor; that assertion records the
  established invariant rather than proving it.
- **Exhaustive matching is the compiler's job where supported.** For closed sum
  types in capable toolchains, require compilation to fail if a new variant is
  added without handling. Use the idiom your language provides: `never`-typed
  binding in TypeScript, `match` enumerating Rust enum variants without a
  catch-all arm, `-Werror=incomplete-patterns` in Haskell, sealed-class match
  exhaustiveness in Kotlin. Where the toolchain cannot enforce closed variants,
  such as Go interface type switches, use an explicit unexpected-case error and
  tests for the known variants; do not claim compiler-enforced exhaustiveness.
- **Derive types from authoritative schemas.** When a protocol buffer, OpenAPI
  spec, GraphQL schema, database migration, or design-system token file defines
  a shape, derive from it instead of hand-rolling a parallel type. See the
  [encode-lessons-in-structure principle](../principle-encode-lessons-in-structure/SKILL.md).
- **Strengthen a type where it prevents meaningful invalid behavior.** A runtime
  assertion, "this should never happen" throw, or plausible but wrong result can
  mark a place where the type is too weak. Push that check up into the type when
  a better model removes the invalid case. A null check handling modeled absence
  is ordinary case handling; preserve that branch. Then stop. The type system's
  job is to track the cases each use site must handle, not to describe the data
  as precisely as possible. Prefer total functions. `sum` of an empty list is 0,
  so it takes the plain list. `head` of an empty list has no answer, so it
  demands the non-empty one.

**The tests:**

- "Do mutually exclusive states need a comment explaining which fields may
  coexist?" Model those variants as a sum type. Numeric and other value
  constraints may instead need validated constructors.
- "Do two of my function arguments share a primitive type but mean different
  things?" Brand them.
- "Where did this `any`, this type-overriding assertion, this `assertNotNull`
  come from?" Trace unchecked input to its boundary and validate there.
- "If a new variant is added next month, will the compiler tell the next agent
  where to add a case?" Require that check where the toolchain supports it;
  otherwise make the unexpected-case error and known-variant tests explicit.
- "Is this type duplicating a shape another file owns?" Derive instead.
- "Does strengthening this type prevent a meaningful invalid result or unhandled
  case, or just add precision?" If it prevents neither, keep the plain type.
