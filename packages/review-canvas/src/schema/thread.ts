import * as Schema from "effect/Schema"
import * as Limits from "./limits.ts"
import { HostSessionId, nonEmptyText, ThreadId } from "./primitives.ts"

/** The agent hosts a thread can run in. */
export const HOSTS = ["claude-code", "codex", "t3"] as const

/** Where a thread runs, and the host's own session ID when the agent can read it. */
export const ThreadHost = Schema.Struct({
  kind: Schema.Literals(HOSTS),
  session_id: Schema.optionalKey(HostSessionId)
})
export type ThreadHost = typeof ThreadHost.Type

/**
 * An agent conversation that takes part in a review. Registration gives it an ID and a token: the ID names it in
 * every round and answer it writes, and the token, which never appears here, proves a request comes from it.
 */
export const Thread = Schema.Struct({
  id: ThreadId,
  /** A short name the reviewer reads, such as "Claude Code: fix the retry loop". */
  label: nonEmptyText(Limits.MAX_LABEL_UNITS),
  host: ThreadHost
})
export type Thread = typeof Thread.Type
