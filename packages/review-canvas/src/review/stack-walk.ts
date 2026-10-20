/**
 * Stack walkthroughs as pure functions: which PRs a tip's walkthrough covers, the steps it resolves to against each
 * layer's review, which steps the reviewer read at the versions they show now, and where the reviewer resumes. The
 * store and the publish command call these; nothing here reads the database or the host.
 */
import { createHash } from "node:crypto";
import * as Schema from "effect/Schema";
import type { ReviewFile, ReviewInput } from "../schema/input.ts";
import * as Limits from "../schema/limits.ts";
import type {
  CommitSha,
  PullRequestUrl,
  ReviewId,
  RoundNumber,
  StepDigest,
} from "../schema/primitives.ts";
import type { OpenPullRequest } from "../schema/pull-requests.ts";
import type {
  LayerState,
  ReadFile,
  StackLayerView,
  StackProgress,
  StackPublishRequest,
  StackRecord,
  StackStepView,
  StepMark,
  StepRead,
} from "../schema/stack.ts";
import { StepKey } from "../schema/stack.ts";
import { pullRequestKey } from "../schema/target.ts";
import { patchDigest } from "./anchor.ts";
import { authoredSteps, layerInput, pullNumber } from "./stack-steps.ts";
import { pullRequestStacks, stackAncestors } from "./stacks.ts";
import { tourView } from "./tour.ts";

/**
 * The tip's ancestor path from the root, and the other PRs of its stack, which the walkthrough leaves out: siblings
 * of a branching stack and PRs that build on the tip. Undefined when the tip is not in the list.
 */
export const stackPath = (
  items: ReadonlyArray<OpenPullRequest>,
  tip: PullRequestUrl,
):
  | {
      readonly path: ReadonlyArray<OpenPullRequest>;
      readonly excluded: ReadonlyArray<OpenPullRequest>;
    }
  | undefined => {
  const path = stackAncestors(items, tip);
  if (path.length === 0) return undefined;
  const members = new Set(path.map((pull) => pullRequestKey(pull.url)));
  const stack = pullRequestStacks(items).find((layers) =>
    layers.some(
      (layer) => pullRequestKey(layer.pull.url) === pullRequestKey(tip),
    ),
  );
  return {
    path,
    excluded: (stack ?? [])
      .map((layer) => layer.pull)
      .filter((pull) => !members.has(pullRequestKey(pull.url))),
  };
};

/** Why a publication cannot stand: the store raises it as a refusal. */
export class StackRefused extends Error {}

/** The open review of each layer the publication's threads authenticated for, with its current round's input. */
export interface LayerReview {
  readonly review: ReviewId;
  readonly url: PullRequestUrl;
  readonly target_key: string;
  readonly input: ReviewInput | undefined;
}

/**
 * Checks a publication against the reviews its threads belong to, and pins each layer to its review's target. The
 * path ends at the tip, has each PR once, and leaves out every excluded PR; each step names a layer, in base-to-tip
 * order; and each layer's review shows the head the command read from the host.
 */
export const pinLayers = (
  request: Omit<StackPublishRequest, "sessions">,
  reviews: ReadonlyArray<LayerReview>,
): StackRecord["layers"] => {
  const keys = request.path.map((layer) => pullRequestKey(layer.url));
  if (new Set(keys).size !== keys.length)
    throw new StackRefused("The stack path names a PR more than once.");
  if (keys.at(-1) !== pullRequestKey(request.walkthrough.tip))
    throw new StackRefused("The stack path must end at the walkthrough's tip.");
  for (const excluded of request.excluded)
    if (keys.includes(pullRequestKey(excluded.url)))
      throw new StackRefused(
        `${pullNumber(excluded.url)} is both on the path and excluded from it.`,
      );
  let last = 0;
  const perLayer = new Array<number>(keys.length).fill(0);
  for (const [index, step] of request.walkthrough.steps.entries()) {
    const layer = keys.indexOf(pullRequestKey(step.layer));
    if (layer === -1)
      throw new StackRefused(
        `Step ${index + 1} ("${step.title}") names ${pullNumber(step.layer)}, which is not an ancestor of the tip. Sibling branches are not part of this walkthrough.`,
      );
    if (layer < last)
      throw new StackRefused(
        `Step ${index + 1} ("${step.title}") goes back to ${pullNumber(step.layer)}. Order the steps from the base layer to the tip.`,
      );
    last = layer;
    perLayer[layer] = (perLayer[layer] ?? 0) + 1;
    if ((perLayer[layer] ?? 0) > Limits.MAX_STOPS)
      throw new StackRefused(
        `${pullNumber(step.layer)} has more than ${Limits.MAX_STOPS} steps.`,
      );
  }
  return request.path.map((layer) => {
    const review = reviews.find(
      (item) => pullRequestKey(item.url) === pullRequestKey(layer.url),
    );
    if (review === undefined)
      throw new StackRefused(
        `No thread given for ${pullNumber(layer.url)}. Register and publish a review of every layer, and pass each one's --session.`,
      );
    const head = review.input?.target.head_sha;
    if (head === undefined)
      throw new StackRefused(
        `The review of ${pullNumber(layer.url)} has no round yet. Publish one first.`,
      );
    if (head !== layer.head_sha)
      throw new StackRefused(
        `The review of ${pullNumber(layer.url)} shows ${head.slice(0, 12)}, but the host's head is ${layer.head_sha.slice(0, 12)}. Publish a round at the current head first.`,
      );
    return { ...layer, target_key: review.target_key };
  });
};

/** A layer's review as the store found it now. */
export type LayerSource =
  | {
      readonly kind: "current";
      readonly review: ReviewId;
      readonly round: RoundNumber;
      readonly input: ReviewInput;
    }
  | {
      readonly kind: "stale";
      readonly review: ReviewId;
      readonly head_sha: CommitSha;
    }
  | { readonly kind: "missing"; readonly review?: ReviewId | undefined };

/** The version of a file a mark records: its fingerprint, or else its patch, so an unchanged file keeps its mark. */
export const fileVersion = (file: ReviewFile): string =>
  file.fingerprint ??
  (file.patch === undefined
    ? `none:${file.status}:${file.patch_note ?? ""}`
    : patchDigest(file.patch));

const sameFiles = (a: ReadonlyArray<ReadFile>, b: ReadonlyArray<ReadFile>) =>
  a.length === b.length &&
  a.every(
    (file, index) =>
      file.path === b[index]?.path && file.version === b[index]?.version,
  );

/** A mark holds while the layer shows the head and the file versions it was made at. */
export const readState = (
  mark: StepMark | undefined,
  now:
    | { readonly head_sha: CommitSha; readonly files: ReadonlyArray<ReadFile> }
    | undefined,
): StepRead => {
  if (mark === undefined) return "unread";
  return now !== undefined &&
    mark.head_sha === now.head_sha &&
    sameFiles(mark.files, now.files)
    ? "read"
    : "changed";
};

/** What a mark of a step would record now, for steps of a current layer: every file the step shows, not only its own. */
export interface StepVersion {
  readonly head_sha: CommitSha;
  readonly files: ReadonlyArray<ReadFile>;
}

/** The digest a page sends back to read a step at the version it showed. */
export const stepDigest = (version: StepVersion): StepDigest =>
  createHash("sha256")
    .update(
      JSON.stringify([
        version.head_sha,
        version.files.map((file) => [file.path, file.version]),
      ]),
      "utf8",
    )
    .digest("hex") as StepDigest;

export interface ResolvedStack {
  readonly layers: ReadonlyArray<StackLayerView>;
  readonly steps: ReadonlyArray<StackStepView>;
  readonly versions: ReadonlyMap<StepKey, StepVersion>;
  readonly position: StepKey;
  readonly warnings: ReadonlyArray<string>;
}

const key = Schema.decodeSync(StepKey);

const layerState = (source: LayerSource): LayerState => {
  switch (source.kind) {
    case "current":
      return { kind: "current", review: source.review, round: source.round };
    case "stale":
      return {
        kind: "stale",
        review: source.review,
        head_sha: source.head_sha,
      };
    case "missing":
      return source.review === undefined
        ? { kind: "missing" }
        : { kind: "missing", review: source.review };
  }
};

/**
 * The walkthrough's steps, layer by layer. A current layer resolves its steps as its tour, with a closing stop for
 * the files none covers, so every file of the path is on some step. A stale or missing layer keeps the agent's prose
 * without excerpts, which may not fit the code it shows now; a layer with no step then gets one placeholder, so the
 * gap stays visible in the progression. A mark counts only at the head and file versions it was made at.
 */
export const resolveStack = (
  record: StackRecord,
  sources: ReadonlyArray<LayerSource>,
  progress: StackProgress,
): ResolvedStack => {
  const marks = new Map(progress.marks.map((mark) => [mark.step, mark]));
  const steps: Array<StackStepView> = [];
  const versions = new Map<StepKey, StepVersion>();
  const warnings: Array<string> = [];
  const layers = record.layers.map((layer, index): StackLayerView => {
    const source = sources[index] ?? { kind: "missing" };
    const authored = authoredSteps(record, layer.url);
    if (source.kind === "current") {
      const input = layerInput(record, layer.url, source.input);
      const files = new Map(input.files.map((file) => [file.path, file]));
      const tour = tourView(input);
      warnings.push(
        ...tour.warnings.map(
          (warning) => `${pullNumber(layer.url)}: ${warning}`,
        ),
      );
      for (const stop of tour.stops) {
        const step = key(
          stop.closing ? `L${index}:other` : `L${index}:S${stop.index}`,
        );
        // An excerpt of a file an earlier step owns shows that file too, so its change reopens this step as well.
        const version: StepVersion = {
          head_sha: input.target.head_sha,
          files: [...new Set(stop.files.map((file) => file.path))].flatMap(
            (path) => {
              const file = files.get(path);
              return file === undefined
                ? []
                : [{ path, version: fileVersion(file) }];
            },
          ),
        };
        versions.set(step, version);
        const written = stop.closing
          ? undefined
          : authored[stop.index]?.authored;
        steps.push({
          key: step,
          layer: index,
          stop: stop.index,
          ...(written === undefined ? {} : { authored: written }),
          title: stop.title,
          summary: stop.summary,
          attention: stop.attention,
          questions: stop.questions,
          closing: stop.closing,
          files: stop.owns.length,
          read: readState(marks.get(step), version),
          version: stepDigest(version),
        });
      }
    } else if (authored.length === 0) {
      const step = key(`L${index}:missing`);
      steps.push({
        key: step,
        layer: index,
        title: `${pullNumber(layer.url)} ${layer.title}`,
        summary: "",
        attention: null,
        questions: [],
        closing: false,
        files: 0,
        read: readState(marks.get(step), undefined),
      });
    } else {
      for (const [at, { stop, authored: written }] of authored.entries()) {
        const step = key(`L${index}:S${at}`);
        steps.push({
          key: step,
          layer: index,
          authored: written,
          title: stop.title,
          summary: stop.summary,
          attention: stop.attention,
          questions: stop.questions,
          closing: false,
          files: 0,
          read: readState(marks.get(step), undefined),
        });
      }
    }
    return {
      url: layer.url,
      title: layer.title,
      head_sha: layer.head_sha,
      state: layerState(source),
    };
  });
  return {
    layers,
    steps,
    versions,
    position: resumeAt(steps, progress.position),
    warnings,
  };
};

/** Where the reviewer resumes: the step they were on, or else the first step they have not read at its version. */
export const resumeAt = (
  steps: ReadonlyArray<Pick<StackStepView, "key" | "read">>,
  position: StepKey | undefined,
): StepKey => {
  if (position !== undefined && steps.some((step) => step.key === position))
    return position;
  const first = steps.find((step) => step.read !== "read") ?? steps.at(-1);
  if (first === undefined)
    throw new Error("A stack walkthrough always has a step.");
  return first.key;
};

/**
 * Progress a republished walkthrough keeps: the position, and marks of steps the agent left as they were on the same
 * layer. A mark still counts only at the head and file versions it was made at.
 */
export const carryProgress = (
  before: StackRecord,
  after: StackRecord,
  progress: StackProgress,
): StackProgress => {
  /** What a step key names in a record: its layer's PR, and the agent's stop, or the closing or placeholder step. */
  const named = (record: StackRecord, step: StepKey) => {
    const [layerPart = "", stopPart = ""] = step.split(":");
    const layer = record.layers[Number(layerPart.slice(1))];
    if (layer === undefined) return undefined;
    const stop = stopPart.startsWith("S")
      ? authoredSteps(record, layer.url)[Number(stopPart.slice(1))]?.stop
      : stopPart;
    return stop === undefined
      ? undefined
      : JSON.stringify([pullRequestKey(layer.url), stop]);
  };
  const kept = (step: StepKey) => {
    const was = named(before, step);
    return was !== undefined && was === named(after, step);
  };
  return {
    ...(progress.position !== undefined && kept(progress.position)
      ? { position: progress.position }
      : {}),
    marks: progress.marks.filter((mark) => kept(mark.step)),
  };
};
