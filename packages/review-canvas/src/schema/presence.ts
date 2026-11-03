/**
 * Whether an agent listens to a review: a thread waits for the reviewer through `review-canvas wait`, or waited a
 * moment ago and is about to wait again. The page shows it beside the connection state, and says so when what the
 * reviewer sends has nobody to read it yet.
 */
import * as Schema from "effect/Schema";
import { ThreadId, Timestamp } from "./primitives.ts";

export const Presence = Schema.Union([
  /** These threads wait for the reviewer now, or did within the last minute. */
  Schema.Struct({
    state: Schema.Literal("listening"),
    threads: Schema.NonEmptyArray(ThreadId),
  }),
  /** No thread waits; the one seen last was seen at `seen_at`. */
  Schema.Struct({
    state: Schema.Literal("away"),
    thread: ThreadId,
    seen_at: Timestamp,
  }),
  /** No thread of the review has been heard from. */
  Schema.Struct({ state: Schema.Literal("never") }),
]);
export type Presence = typeof Presence.Type;
