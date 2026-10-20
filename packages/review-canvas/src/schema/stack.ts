/**
 * A stack walkthrough: one tour the agent writes across the layers of a PR stack's selected ancestor path. Each step is
 * a tour stop of one layer, resolved against that layer's own review, so excerpts, inline threads, and approvals stay
 * in the per-PR review. The walkthrough adds only the order across layers and the reviewer's stack-wide progress.
 */
import * as Schema from "effect/Schema";
import * as Limits from "./limits.ts";
import {
  CommitSha,
  Count,
  integer,
  nonEmptyText,
  PullRequestUrl,
  RepoPath,
  ReviewId,
  Revision,
  RoundNumber,
  StackId,
  text,
  ThreadToken,
  Timestamp,
} from "./primitives.ts";
import { Attention, Stop } from "./tour.ts";

/** The format key of a stack walkthrough, as the agent writes it. */
export const STACK_FORMAT = "review-canvas.stack/1";

/** A PR's title as the host reports it, which can be empty. */
const Title = text(Limits.MAX_TEXT_UNITS);

/** A tour stop of one layer, which its PR URL names. The layer's review resolves its excerpts and notes. */
export const StackStep = Schema.Struct({
  layer: PullRequestUrl,
  ...Stop.fields,
});
export type StackStep = typeof StackStep.Type;

/** What the agent writes: the tip PR whose ancestors the walkthrough covers, and its steps from base to tip. */
export const StackWalkthroughInput = Schema.Struct({
  format: Schema.Literal(STACK_FORMAT),
  title: nonEmptyText(Limits.MAX_LABEL_UNITS),
  summary: Schema.optionalKey(text(Limits.MAX_TEXT_UNITS)),
  tip: PullRequestUrl,
  steps: Schema.Array(StackStep).check(
    Schema.isMaxLength(Limits.MAX_STACK_STEPS),
  ),
});
export type StackWalkthroughInput = typeof StackWalkthroughInput.Type;

/** A PR of the selected ancestor path, with the head the command read from the host. */
export const StackPathLayer = Schema.Struct({
  url: PullRequestUrl,
  title: Title,
  head_sha: CommitSha,
});
export type StackPathLayer = typeof StackPathLayer.Type;

/** A PR of the same stack that is not an ancestor of the tip, such as a sibling branch. */
export const StackExcluded = Schema.Struct({
  url: PullRequestUrl,
  title: Title,
});
export type StackExcluded = typeof StackExcluded.Type;

/** A thread's credentials for one layer's review. Every layer needs a thread of its review. */
export const StackSession = Schema.Struct({
  review: ReviewId,
  token: ThreadToken,
});

/** What `stack-publish` sends: the walkthrough, the path it verified on the host, and a thread of each layer. */
export const StackPublishRequest = Schema.Struct({
  walkthrough: StackWalkthroughInput,
  /** Read from merged and closed PRs' final retained heads. */
  historical: Schema.Boolean,
  path: Schema.Array(StackPathLayer).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(Limits.MAX_STACK_LAYERS),
  ),
  excluded: Schema.Array(StackExcluded).check(
    Schema.isMaxLength(Limits.MAX_STACK_STEPS),
  ),
  sessions: Schema.Array(StackSession).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(Limits.MAX_STACK_LAYERS),
  ),
});
export type StackPublishRequest = typeof StackPublishRequest.Type;

/** A layer as the store pins it: the head its review showed at publication, and the target key that finds the review. */
export const StackLayerRecord = Schema.Struct({
  ...StackPathLayer.fields,
  target_key: Schema.String,
});
export type StackLayerRecord = typeof StackLayerRecord.Type;

export const StackRecord = Schema.Struct({
  id: StackId,
  created_at: Timestamp,
  closed_at: Schema.optionalKey(Timestamp),
  /** The walkthrough of the same tip this one replaced. */
  carry_from: Schema.optionalKey(StackId),
  walkthrough: StackWalkthroughInput,
  historical: Schema.Boolean,
  layers: Schema.Array(StackLayerRecord),
  excluded: Schema.Array(StackExcluded),
});
export type StackRecord = typeof StackRecord.Type;

/**
 * A step's place: its layer, then its stop in that layer's tour, the layer's closing stop, or the one placeholder of a
 * layer that has no step and no current review. Keys stay stable while a layer's later rounds change its files.
 */
export const StepKey = Schema.String.check(
  Schema.isPattern(/^L[0-9]{1,3}:(?:S[0-9]{1,4}|other|missing)$/, {
    expected: "a stack step key such as L0:S1",
  }),
).pipe(Schema.brand("StepKey"));
export type StepKey = typeof StepKey.Type;

/** A file of a read step, by the version the reviewer read: its fingerprint, or its patch's digest. */
export const ReadFile = Schema.Struct({
  path: RepoPath,
  version: Schema.String,
});
export type ReadFile = typeof ReadFile.Type;

/** The reviewer read a step at a layer head and file versions. A later change to either reopens the step. */
export const StepMark = Schema.Struct({
  step: StepKey,
  head_sha: CommitSha,
  files: Schema.Array(ReadFile),
  read_at: Timestamp,
});
export type StepMark = typeof StepMark.Type;

/** Where the reviewer is in the walkthrough, and what they read. The server keeps it, so every tab resumes there. */
export const StackProgress = Schema.Struct({
  position: Schema.optionalKey(StepKey),
  marks: Schema.Array(StepMark),
});
export type StackProgress = typeof StackProgress.Type;

/**
 * A layer's review now. Current: its round shows the pinned head. Stale: the review moved to another head, so the
 * agent's excerpts may no longer fit. Missing: no open review, or one with no round yet.
 */
export const LayerState = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("current"),
    review: ReviewId,
    round: RoundNumber,
  }),
  Schema.Struct({
    kind: Schema.Literal("stale"),
    review: ReviewId,
    head_sha: CommitSha,
  }),
  Schema.Struct({
    kind: Schema.Literal("missing"),
    review: Schema.optionalKey(ReviewId),
  }),
]);
export type LayerState = typeof LayerState.Type;

export const StackLayerView = Schema.Struct({
  ...StackPathLayer.fields,
  state: LayerState,
});
export type StackLayerView = typeof StackLayerView.Type;

/** Read: read at the layer's current head and file versions. Changed: read, but the head or a file changed since. */
export const StepRead = Schema.Literals(["unread", "read", "changed"]);
export type StepRead = typeof StepRead.Type;

const Index = integer(0, Limits.MAX_STACK_STEPS);

export const StackStepView = Schema.Struct({
  key: StepKey,
  layer: Index,
  /** The step's stop in the layer's resolved tour, while the layer is current. */
  stop: Schema.optionalKey(Index),
  /** The step the agent wrote, by its index in the walkthrough. Closing and placeholder steps have none. */
  authored: Schema.optionalKey(Index),
  title: nonEmptyText(Limits.MAX_TEXT_UNITS),
  summary: Schema.String,
  attention: Schema.NullOr(Attention),
  questions: Schema.Array(Schema.String),
  closing: Schema.Boolean,
  /** Files this step is the first to cover in its layer. */
  files: Count,
  read: StepRead,
});
export type StackStepView = typeof StackStepView.Type;

/** A walkthrough as its page follows it: every layer's state, every step, and where the reviewer resumes. */
export const StackSnapshot = Schema.Struct({
  id: StackId,
  revision: Revision,
  created_at: Timestamp,
  closed_at: Schema.optional(Timestamp),
  replaced_by: Schema.optional(StackId),
  walkthrough: StackWalkthroughInput,
  historical: Schema.Boolean,
  layers: Schema.Array(StackLayerView),
  excluded: Schema.Array(StackExcluded),
  steps: Schema.Array(StackStepView),
  position: StepKey,
  /** What the server left out of the agent's steps, for the agent to read. */
  warnings: Schema.Array(Schema.String),
});
export type StackSnapshot = typeof StackSnapshot.Type;

/** A page's change to its walkthrough progress: move, optionally marking the step it leaves read, or unmark a step. */
export const StackAction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("go"),
    step: StepKey,
    read: Schema.optionalKey(StepKey),
  }),
  Schema.Struct({ kind: Schema.Literal("unread"), step: StepKey }),
]);
export type StackAction = typeof StackAction.Type;

/** An open walkthrough as the home page and per-PR pages link it. */
export const StackSummary = Schema.Struct({
  id: StackId,
  title: Schema.String,
  tip: PullRequestUrl,
  layers: Schema.Array(PullRequestUrl),
  steps: Count,
  read: Count,
  historical: Schema.Boolean,
});
export type StackSummary = typeof StackSummary.Type;
