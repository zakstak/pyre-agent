/** A stack walkthrough as the page holds it: the snapshot the server pushes, and the one way to move through it. */
import { Effect, type Exit, Stream } from "effect";
import { Atom } from "effect/reactivity";
import type { Revision, StackId } from "../../schema/primitives.ts";
import type { StackAction } from "../../schema/stack.ts";
import { type CallError, epochAtom, PageClient } from "../rpc.ts";

/** The walkthrough now, and again after it or a review of one of its layers changes. */
export const stackAtom = Atom.family((id: StackId) =>
  PageClient.runtime.atom((get) =>
    get(epochAtom) === 0
      ? Stream.never
      : Stream.unwrap(
          Effect.gen(function* () {
            const client = yield* PageClient;
            return client("stack.watch", { id });
          }),
        ),
  ),
);

/** Sends a move or a mark; the next snapshot shows it. */
export const stackActAtom = Atom.family((id: StackId) =>
  PageClient.runtime
    .atom(
      Effect.gen(function* () {
        const client = yield* PageClient;
        return (action: StackAction): Promise<Exit.Exit<Revision, CallError>> =>
          Effect.runPromiseExit(
            client("stack.act", { id, action }).pipe(
              Effect.map((done) => done.revision),
            ),
          );
      }),
    )
    .pipe(Atom.keepAlive),
);
