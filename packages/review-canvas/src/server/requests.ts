/** What agents send over the socket, decoded at the boundary. Pages send the RPCs in schema/rpc.ts. */
import * as Schema from "effect/Schema";
import { Answer } from "../schema/feedback.ts";
import * as Limits from "../schema/limits.ts";
import { CommentId, CommitSha, nonEmptyText, RepoPath } from "../schema/primitives.ts";
import { Target } from "../schema/target.ts";
import { ThreadHost } from "../schema/thread.ts";

export const RegisterRequest = Schema.Struct({
  target: Target,
  label: nonEmptyText(Limits.MAX_LABEL_UNITS),
  host: ThreadHost,
  /** Start a new review of the target instead of joining its open one. */
  fresh: Schema.optionalKey(Schema.Boolean),
});
export type RegisterRequest = typeof RegisterRequest.Type;

export const AnswerRequest = Schema.Struct({
  comment: CommentId,
  answer: Answer,
});
export type AnswerRequest = typeof AnswerRequest.Type;

/** The largest JSON body a page or an agent may send, other than a round's input. */
export const MAX_REQUEST_BYTES = 1024 * 1024;

/** What an agent found when it compared the code with the current round. */
export const DriftRequest = Schema.Struct({
  paths: Schema.Array(RepoPath).check(Schema.isMaxLength(Limits.MAX_FILES)),
  head_sha: Schema.optionalKey(CommitSha),
});
export type DriftRequest = typeof DriftRequest.Type;
