/** What pages and agents send, decoded at the boundary. Everything past it is typed. */
import * as Schema from "effect/Schema";
import { Answer, REVIEWER_ACTIONS, VERDICTS } from "../schema/feedback.ts";
import * as Limits from "../schema/limits.ts";
import {
  CommentId,
  Fingerprint,
  integer,
  nonEmptyText,
  PatchDigest,
  RepoPath,
  Revision,
  RoundNumber,
  text,
} from "../schema/primitives.ts";
import { Target } from "../schema/target.ts";
import { ThreadHost } from "../schema/thread.ts";

const Row = integer(0, Limits.MAX_ROW);
const Body = text(Limits.MAX_TEXT_UNITS);
const RequiredBody = nonEmptyText(Limits.MAX_TEXT_UNITS);

export const Selection = Schema.Struct({
  path: RepoPath,
  /** The patch the page showed, so row numbers cannot land on another version of the file. */
  patch_sha256: PatchDigest,
  start_row: Row,
  end_row: Row,
});

/** A change a page asks for. */
export const PageAction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("comment"),
    selection: Selection,
    body: RequiredBody,
  }),
  Schema.Struct({
    kind: Schema.Literal("general_comment"),
    body: RequiredBody,
  }),
  Schema.Struct({
    kind: Schema.Literal("reply"),
    comment: CommentId,
    action: Schema.Literals(REVIEWER_ACTIONS),
    body: Body,
  }),
  Schema.Struct({
    kind: Schema.Literal("approve"),
    path: RepoPath,
    fingerprint: Fingerprint,
  }),
  Schema.Struct({ kind: Schema.Literal("unapprove"), path: RepoPath }),
  Schema.Struct({
    kind: Schema.Literal("submit"),
    round: RoundNumber,
    verdict: Schema.Literals(VERDICTS),
    body: Body,
  }),
  Schema.Struct({
    kind: Schema.Literal("reattach"),
    comment: CommentId,
    selection: Selection,
  }),
]).annotate({
  expected:
    "an action whose kind is comment, general_comment, reply, approve, unapprove, submit, or reattach",
});
export type PageAction = typeof PageAction.Type;

export const PageActionRequest = Schema.Struct({
  action: PageAction,
  /** The revision the page saw. The server refuses the action when the review moved on. */
  revision: Schema.optionalKey(Revision),
});
export type PageActionRequest = typeof PageActionRequest.Type;

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
