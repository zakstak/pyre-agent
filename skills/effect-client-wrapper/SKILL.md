---
name: effect-client-wrapper
description:
  "Use when creating Effect 4 services around Promise-based third-party SDKs,
  such as Stripe, Resend, or AWS. Covers the use pattern, typed SDK errors,
  tracing, configuration, and dependency injection."
metadata:
  version: "1.0.0"
---

# Wrap SDK clients with Effect 4

Target Effect 4. The examples use `effect` 4.0.6 and `stripe` 23.0.1 with its
own TypeScript declarations. Use the project's compatible versions. Do not copy
Effect 3 APIs such as `Context.Tag` or `Config.redacted` into this wrapper.

Keep SDK construction and Promise conversion at the adapter boundary. Expose a
`use` function that maps thrown or rejected SDK failures into a tagged error and
traces each operation. Keep the raw client in the implementation's closure.

## Build the service

Use `Context.Service` for the service key, `Config.Redacted` for secrets, and
the curried `Layer.effect(Service)(effect)` constructor for its live layer:

```ts
import Stripe from "stripe";
import { Config, Context, Data, Effect, Layer, Redacted } from "effect";

export class StripeError extends Data.TaggedError("StripeError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export class StripeClientInstantiationError extends Data.TaggedError(
  "StripeClientInstantiationError",
)<{
  readonly cause: unknown;
}> {}

export type StripeClientService = Readonly<{
  use: <A>(
    operation: string,
    fn: (client: Stripe) => PromiseLike<A>,
  ) => Effect.Effect<A, StripeError>;
}>;

export class StripeClient extends Context.Service<
  StripeClient,
  StripeClientService
>()("app/StripeClient") {
  static readonly Default = Layer.effect(StripeClient)(
    Effect.gen(function* () {
      const secretKey = yield* Config.Redacted("STRIPE_SECRET_KEY");
      const client = yield* Effect.try({
        try: () =>
          new Stripe(Redacted.value(secretKey), { maxNetworkRetries: 0 }),
        catch: (cause) => new StripeClientInstantiationError({ cause }),
      });

      const use: StripeClientService["use"] = (operation, fn) =>
        Effect.tryPromise({
          try: () => fn(client),
          catch: (cause) => new StripeError({ operation, cause }),
        }).pipe(
          Effect.withSpan(`stripe.${operation}`, {
            attributes: { module: "StripeClient" },
          }),
        );

      return { use };
    }),
  );
}
```

The layer reports configuration errors and constructor failures during service
acquisition. `use` reports failures when the SDK operation runs. Preserve those
different error channels so callers can distinguish setup failures from request
failures.

`Effect.tryPromise` defers the callback until execution and catches both a
synchronous throw and a rejected Promise. Construct the Promise inside its `try`
callback. Wrapping an already-started Promise loses that laziness and reuses the
same request on retries.

## Call an operation

Give each call a stable operation name. Anonymous callbacks often have an empty
`fn.name`, so `fn.name ?? "use"` does not give reliable span names.

```ts
export const createCustomer = (
  params: Stripe.CustomerCreateParams,
  idempotencyKey: string,
) =>
  Effect.gen(function* () {
    const stripe = yield* StripeClient;
    return yield* stripe.use("customers.create", (client) =>
      client.customers.create(params, { idempotencyKey }),
    );
  });

// Provide the live layer at the application's composition boundary.
const program = createCustomer(
  { email: "user@example.com" },
  "example-customer-creation",
).pipe(Effect.provide(StripeClient.Default));
```

The idempotency key above illustrates one logical operation. Production callers
must supply a key stable across retries of that operation and distinct from
unrelated operations. Do not reuse the example key for real requests.

The service acquires its SDK client once per layer build. `use` does not
reconstruct the client for each call. Do not expose a `client` property beside
`use`: that lets callers bypass error conversion and tracing.

If an SDK client owns resources that need cleanup, acquire it with
`Effect.acquireRelease` inside the layer. Register its documented cleanup
operation so closing the layer's scope releases those resources.

Span attributes apply to the operation's execution. Annotating only layer
construction does not annotate later calls to a captured function. Keep API keys
and request bodies out of span names and attributes. `Redacted` protects the
configuration value's display, not arbitrary SDK error contents.

## Classify only errors callers handle differently

Start with one tagged SDK error that retains `cause: unknown`. Add error
variants when the caller needs different behavior, such as retrying a network
failure or reporting a validation failure.

Use the SDK's exported error classes or documented discriminants to narrow an
unknown cause. Do not assert that every thrown value is an SDK error. Avoid
mapping constructor failures, configuration errors, and request errors into one
indistinguishable failure.

Some SDKs resolve an error envelope such as `{ data, error }` instead of
rejecting. `Effect.tryPromise` treats that resolution as success. Inspect the
documented result and turn a reported error into an Effect failure at the
adapter boundary. Wrapping a Promise alone does not validate its payload.

## Expose named operations to application code

Keep generic `use` in the SDK adapter. When application code needs a narrower
contract, create a service with methods such as `sendEmail` or
`retrieveCustomer`. Implement those methods through the adapter's `use`.

Derive SDK request types from the SDK declarations inside the adapter. Convert
SDK responses and errors into domain types before returning them from a domain
service. This gives application tests a small service to replace without mocking
an entire vendor SDK.

## Propagate cancellation where supported

For an SDK that accepts an `AbortSignal`, extend the callback signature with
`signal: AbortSignal` and pass Effect's signal into it:

```ts
type SdkUse<Client> = <A>(
  operation: string,
  fn: (client: Client, signal: AbortSignal) => PromiseLike<A>,
) => Effect.Effect<A, StripeError>;

// Inside an implementation that owns `client`:
const use: SdkUse<typeof client> = (operation, fn) =>
  Effect.tryPromise({
    try: (signal) => fn(client, signal),
    catch: (cause) => new StripeError({ operation, cause }),
  }).pipe(Effect.withSpan(`sdk.${operation}`));
```

Pass the signal to the SDK's actual cancellation option. Do not add a fictional
signal option to Stripe or another SDK that lacks it. Interrupting the Effect
stops waiting; it stops the underlying request only if the SDK observes the
signal or another supported cancellation mechanism.

## Retry at the operation boundary

Do not put an unconditional retry inside generic `use`. It would retry
authentication failures, invalid requests, and writes that may already have
completed remotely.

Apply a bounded retry policy only to operations whose failure classification and
idempotency permit it. Use backoff and jitter where appropriate. Preserve an
SDK-supported idempotency key across attempts of a write. Respect retry hints
such as `Retry-After` when the provider requires them.

Account for SDK attempts before adding an Effect retry policy. The Stripe
example sets `maxNetworkRetries` to zero to disable configurable network
retries. Stripe 23.0.1 still retries the first `ECONNRESET` or `EPIPE` once,
even with that setting. Include this exception in the total attempt budget.

## Test the boundary without remote calls

Use a fake SDK transport to verify that callbacks are lazy, return their success
values, and map both synchronous throws and Promise rejections to the tagged
request error. Check that layer acquisition reports missing configuration and
constructor failures separately.

Test tracing with an anonymous callback and verify the explicit operation name.
For cancellable SDKs, interrupt a pending call and verify that its signal is
aborted. For domain consumers, inject a test layer with
`Layer.succeed(Service)(implementation)` rather than patching global SDK methods
or loading real credentials.

## Official references

These links pin the API documentation to the versions used above. Check the
matching version when adapting the examples:

- [Effect 4 service keys](https://github.com/Effect-TS/effect/blob/effect%404.0.6/packages/effect/src/Context.ts#L209-L235).
- [Effect 4 redacted configuration](https://github.com/Effect-TS/effect/blob/effect%404.0.6/packages/effect/src/Config.ts#L1449-L1486).
- [Effect 4 layer construction](https://github.com/Effect-TS/effect/blob/effect%404.0.6/packages/effect/src/Layer.ts#L1008-L1050).
- [Scoped resource acquisition](https://github.com/Effect-TS/effect/blob/effect%404.0.6/packages/effect/src/Effect.ts#L6819-L6866).
- [Promise conversion and cancellation](https://github.com/Effect-TS/effect/blob/effect%404.0.6/packages/effect/src/Effect.ts#L929-L1018).
- [Operation spans](https://github.com/Effect-TS/effect/blob/effect%404.0.6/packages/effect/src/Effect.ts#L8697-L8735).
- [Stripe network retries](https://github.com/stripe/stripe-node/blob/v23.0.1/README.md#network-retries).
