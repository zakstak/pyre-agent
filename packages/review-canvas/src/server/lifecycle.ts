/** Lifecycle requests exist only on the private agent socket, never on the page port. */
import { Context, Deferred, Effect, Layer, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { randomUUID } from "node:crypto";
import { installedRevision, ServerIdentity } from "./identity.ts";
import { ok, readJson, refused, RequestRefused } from "./json.ts";

export class Lifecycle extends Context.Service<
  Lifecycle,
  {
    readonly identity: typeof ServerIdentity.Type;
    readonly stopped: Deferred.Deferred<void>;
  }
>()("review-canvas/Lifecycle") {}

export const lifecycleLayer = Layer.effect(
  Lifecycle,
  Effect.gen(function* () {
    return {
      identity: {
        ok: true,
        revision: installedRevision(),
        instance: randomUUID(),
      },
      stopped: yield* Deferred.make<void>(),
    };
  }),
);

export const LifecycleApi = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    "/agent/server",
    Effect.map(Lifecycle, ({ identity }) => ok(identity)),
  ),
  HttpRouter.add(
    "POST",
    "/agent/server/stop",
    Effect.gen(function* () {
      const { identity, stopped } = yield* Lifecycle;
      const body = yield* readJson(
        Schema.Struct({ instance: Schema.String }),
        1024,
      );
      if (body.instance !== identity.instance)
        return refused(
          new RequestRefused(
            409,
            "server_changed",
            "The listening server changed; retry the command.",
          ),
        );
      yield* Deferred.succeed(stopped, undefined);
      return ok({ ok: true });
    }).pipe(Effect.catch((error) => Effect.succeed(refused(error)))),
  ),
);
