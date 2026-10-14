/**
 * The review page as data: what each file block shows, what the next strip says, and how far the round is. A pure
 * function of the snapshot and the rounds' inputs, so the page renders whatever it returns and tests need no browser.
 */
import type { Comment, Verdict } from "../../schema/feedback.ts";
import type { ReviewFile, ReviewInput } from "../../schema/input.ts";
import type { PatchDigest, RepoPath, RoundNumber } from "../../schema/primitives.ts";
import type { ReviewSnapshot } from "../../schema/rpc.ts";
import type { Thread } from "../../schema/thread.ts";
import { unifiedDiff } from "../../review/linediff.ts";
import { answerStep, fileStep, type Next, nextStep } from "../../review/next.ts";
import { type Progress, progress, type Standing, standingOf } from "../../review/progress.ts";
import { currentSubmission, type Round } from "../../review/queries.ts";
import { type StopView, tourView } from "../../review/tour.ts";
import { count, lineRange, splitPath, threadNameOf } from "../names.ts";
import { type InlineComment, type PlacedComment, placeComments } from "./diff-model.ts";

/** The element ID of a note in the diff: by its stop, its excerpt in the stop, and its letter. */
export const noteElementId = (stop: number, excerpt: number, letter: string): string => `s${stop}e${excerpt}-note-${letter}`;

/** A note of the tour, shown in the diff under the row it explains. */
export interface InlineNote {
  readonly id: string;
  readonly row: number;
  readonly letter: string;
  readonly title: string;
  readonly body: string;
  /** For a note of a later stop than the one that owns the file: that stop's number. */
  readonly stop: number | undefined;
}

/**
 * The one status word a header shows. That the reviewer's approval lapsed comes first, then that the file changed
 * since the round before; both open what changed between the rounds. Then what the file is.
 */
export type FileStatus =
  | { readonly kind: "word"; readonly text: string; readonly warning: boolean }
  | { readonly kind: "since"; readonly text: string; readonly warning: boolean; readonly patch: string };

export interface FileModel {
  /** The file's place in the round, which names its table. */
  readonly index: number;
  readonly file: ReviewFile;
  /** The digest of the patch the page shows, which a comment's selection names. */
  readonly digest: PatchDigest | undefined;
  /** An approval of this version of the file holds. */
  readonly approved: boolean;
  /** The reviewer viewed an earlier version, which changed since. */
  readonly lapsed: boolean;
  readonly placed: ReadonlyArray<PlacedComment>;
  readonly orphans: ReadonlyArray<InlineComment>;
  /** Comments not yet resolved, and those whose turn is the reviewer's. */
  readonly open: number;
  readonly forYou: number;
  readonly status: FileStatus | undefined;
  /** The first excerpt's caption, when the owning stop excerpts the file. */
  readonly caption: string | undefined;
  /** The rows the tour excerpts and comments sit on; the rest fold. Undefined shows every row. */
  readonly shown: ReadonlyArray<{ readonly start: number; readonly end: number }> | undefined;
  readonly notes: ReadonlyArray<InlineNote>;
  /** Whether the page folds the file when the reviewer has not chosen. */
  readonly folded: boolean;
  /**
   * Open although the page would fold it, because the strip points at it or an answer on it waits for the reviewer.
   * It stays open from then on, until the reviewer folds it or marks it viewed.
   */
  readonly held: boolean;
  /** Whether the block has a body to fold: a patch, a note about the patch, or comments whose lines left. */
  readonly hasBody: boolean;
  /** "N comments · F for you", when any is open. */
  readonly talk: string | undefined;
}

export const fileStatus = (
  file: ReviewFile,
  lapsed: boolean,
  since: { readonly round: number; readonly patch: string } | undefined,
): FileStatus | undefined => {
  const word = (text: string, warning = false): FileStatus =>
    since === undefined ? { kind: "word", text, warning } : { kind: "since", text, warning, patch: since.patch };
  if (lapsed) return word("changed since you viewed it", true);
  if (since !== undefined) return word(`changed since round ${since.round}`);
  const plain = (text: string): FileStatus => ({ kind: "word", text, warning: false });
  if (file.status === "deleted" || file.status === "removed") return plain("deleted");
  if (file.status === "renamed") return plain(file.old_path === undefined ? "renamed" : `renamed from ${file.old_path}`);
  if (file.patch_note === "binary") return plain("binary");
  if (file.patch_note === "too_large") return plain("too large");
  if (file.status === "added" || file.status === "copied") return plain(file.status);
  return undefined;
};

/** Each file's block as the page shows it: its approval, comments, the tour's excerpts and notes, and its fold. */
const fileModels = (
  snapshot: ReviewSnapshot,
  input: ReviewInput,
  digests: Readonly<Record<RepoPath, PatchDigest>>,
  stops: ReadonlyArray<StopView>,
  next: Next,
  previous: ReviewInput | undefined,
  round: number,
  counts: Progress,
  standing: (comment: Comment) => Standing,
): ReadonlyMap<RepoPath, FileModel> => {
  const { state } = snapshot;
  const owner = new Map<string, StopView>();
  for (const stop of stops) for (const path of stop.owns) if (!owner.has(path)) owner.set(path, stop);
  const before = new Map(previous?.files.map((file) => [file.path, file]) ?? []);
  // The page unfolds what the strip points at.
  const target =
    next.kind === "file"
      ? next.path
      : next.kind === "answer" && next.place.kind === "inline"
        ? next.place.path
        : undefined;
  return new Map(
    input.files.map((file, index): [RepoPath, FileModel] => {
      const { placed, orphans } = placeComments(file, state.comments);
      const comments: ReadonlyArray<Comment> = [...placed.map((item) => item.comment), ...orphans];
      const approved = counts.viewed.has(file.path);
      const lapsed = !approved && state.approvals.some((approval) => approval.path === file.path);
      const stop = owner.get(file.path);
      const excerpts = stops.flatMap((item) =>
        item.excerpts
          .map((excerpt, at) => ({ excerpt, at, stop: item }))
          .filter(({ excerpt }) => excerpt.path === file.path),
      );
      const notes = excerpts.flatMap(({ excerpt, at, stop: from }) =>
        excerpt.notes.map((note) => ({
          id: noteElementId(from.index, at, note.letter),
          row: note.row,
          letter: note.letter,
          title: note.title,
          body: note.body,
          stop: from === stop ? undefined : from.index + 1,
        })),
      );
      const owned = excerpts.filter((item) => item.stop === stop);
      const earlier = before.get(file.path);
      const unchangedSince =
        earlier?.fingerprint !== undefined && earlier.fingerprint === file.fingerprint ? round - 1 : undefined;
      const sincePatch =
        unchangedSince !== undefined || earlier?.new_content === undefined || file.new_content === undefined
          ? undefined
          : unifiedDiff(earlier.new_content, file.new_content);
      const open = comments.filter((comment) => standing(comment) !== "resolved").length;
      const forYou = comments.filter((comment) => standing(comment) === "reviewer").length;
      const foldable =
        approved ||
        file.group === "mechanical" ||
        stop?.closing === true ||
        unchangedSince !== undefined ||
        owned.length === 0;
      // What the strip points at, and a file with an answer waiting for the reviewer, stay open: the reviewer has
      // something to do there.
      const held = foldable && (target === file.path || forYou > 0);
      return [
        file.path,
        {
          index,
          file,
          digest: digests[file.path],
          approved,
          lapsed,
          placed,
          orphans,
          open,
          forYou,
          status: fileStatus(file, lapsed, sincePatch === undefined ? undefined : { round: round - 1, patch: sincePatch }),
          caption: owned[0]?.excerpt.caption,
          shown:
            excerpts.length === 0
              ? undefined
              : [
                  ...excerpts.map(({ excerpt }) => ({ start: excerpt.start_row, end: excerpt.end_row })),
                  ...placed.map((item) => ({ start: item.start, end: item.end })),
                ],
          notes,
          folded: foldable && !held,
          held,
          hasBody: file.patch !== undefined || file.patch_note !== undefined || orphans.length > 0,
          talk: open === 0 ? undefined : `${count(open, "comment")}${forYou > 0 ? ` · ${forYou} for you` : ""}`,
        },
      ];
    }),
  );
};

/** The next strip: what to do, why, and the ID of the element it points at. */
export type Strip =
  | { readonly kind: "go"; readonly what: string; readonly code: string | undefined; readonly why: string; readonly next: Extract<Next, { target: string }> }
  | { readonly kind: "finished"; readonly round: RoundNumber; readonly verdict: Verdict }
  | { readonly kind: "closed" };

const stripOf = (next: Next, threads: ReadonlyArray<Thread>): Strip => {
  switch (next.kind) {
    case "answer": {
      const place =
        next.place.kind === "general"
          ? "on the whole change"
          : `${next.place.path}:${lineRange(next.place.start, next.place.end)}`;
      return {
        kind: "go",
        what: next.github ? "Read the reply" : `Read ${threadNameOf(threads, next.thread ?? "")}’s answer`,
        code: undefined,
        why: [place, ...(next.more > 0 ? [`${next.more} more after this`] : [])].join(" · "),
        next,
      };
    }
    case "file":
      return { kind: "go", what: "Review", code: next.path, why: `stop ${next.stop} · ${count(next.left, "file")} left`, next };
    case "finish":
      return {
        kind: "go",
        what: `Finish round ${next.round}`,
        code: undefined,
        why: `everything viewed, ${next.waiting === 0 ? "nothing waiting" : `${next.waiting} waiting for agents`}`,
        next,
      };
    case "finished":
      return { kind: "finished", round: next.round, verdict: next.verdict };
    case "closed":
      return { kind: "closed" };
  }
};

export interface PageModel {
  readonly snapshot: ReviewSnapshot;
  readonly input: ReviewInput;
  readonly round: Round;
  readonly stops: ReadonlyArray<StopView>;
  readonly files: ReadonlyMap<RepoPath, FileModel>;
  readonly next: Next;
  readonly strip: Strip;
  /** Where the strip's steps go: the first answer for the reviewer and the first file not viewed, when there is one. */
  readonly steps: {
    readonly answer: Extract<Next, { kind: "answer" }> | undefined;
    readonly file: Extract<Next, { kind: "file" }> | undefined;
  };
  readonly progress: Progress;
  readonly standing: (comment: Comment) => Standing;
  readonly writable: boolean;
  /** The reviewer finished this round. */
  readonly finished: boolean;
  /** Inline comments whose file left the round. */
  readonly departed: ReadonlyArray<InlineComment>;
  readonly general: ReadonlyArray<Comment>;
  /** The newest time anything in the review changed, for the top bar. */
  readonly updated: string;
}

/** The review page for a snapshot with a round, its input, and the round before's input when there is one. */
export const pageModel = (
  snapshot: ReviewSnapshot,
  round: Round,
  input: ReviewInput,
  digests: Readonly<Record<RepoPath, PatchDigest>>,
  previous: ReviewInput | undefined,
): PageModel => {
  const { state } = snapshot;
  const { stops } = tourView(input);
  const next = nextStep(state, input, stops, round);
  const counts = progress(state, input);
  const standing = standingOf(state);
  const files = fileModels(snapshot, input, digests, stops, next, previous, round.round, counts, standing);
  return {
    snapshot,
    input,
    round,
    stops,
    files,
    next,
    strip: stripOf(next, snapshot.threads),
    steps: { answer: answerStep(state, input, stops), file: fileStep(state, input, stops) },
    progress: counts,
    standing,
    writable: state.closed_at === undefined,
    finished: currentSubmission(state) !== undefined,
    departed: state.comments.filter(
      (comment): comment is InlineComment => comment.kind === "inline" && !files.has(comment.anchor.path),
    ),
    general: state.comments.filter((comment) => comment.kind === "general"),
    updated: [
      round.published_at,
      ...state.comments.map((comment) => comment.updated_at),
      ...state.approvals.map((item) => item.approved_at),
      ...state.submissions.map((item) => item.submitted_at),
      state.drift?.checked_at ?? "",
    ].reduce((a, b) => (b > a ? b : a)),
  };
};

/** Paths in path order, grouped by their folder; files at the root come first, under no folder. */
export const byDirectory = (paths: Iterable<RepoPath>): ReadonlyArray<{ readonly dir: string; readonly paths: ReadonlyArray<RepoPath> }> => {
  const groups = new Map<string, Array<RepoPath>>();
  for (const path of [...paths].sort((a, b) => a.localeCompare(b))) {
    const { dir } = splitPath(path);
    groups.set(dir, [...(groups.get(dir) ?? []), path]);
  }
  return [...groups].map(([dir, grouped]) => ({ dir, paths: grouped })).sort((a, b) => (a.dir === "" ? -1 : b.dir === "" ? 1 : 0));
};

/** Paths in the order the contents list them, which the source view shows its diff in. */
export const pathOrder = (paths: Iterable<RepoPath>): ReadonlyArray<RepoPath> => byDirectory(paths).flatMap((group) => group.paths);

/** What the finish section says before the reviewer finishes. */
export const finishState = (counts: Progress): string => {
  const notViewed = counts.viewable - counts.viewed.size;
  if (notViewed === 0 && counts.forYou === 0 && counts.waiting === 0) return "Everything viewed, nothing waiting.";
  return `${[
    ...(notViewed === 0 ? [] : [`${count(notViewed, "file")} not yet viewed`]),
    ...(counts.forYou === 0 ? [] : [`${count(counts.forYou, "answer")} waiting for you`]),
    ...(counts.waiting === 0 ? [] : [`${count(counts.waiting, "comment")} waiting for agents`]),
  ].join(" · ")}. You can finish anyway.`;
};

/** Where an orphaned comment pointed, in the round it was made in. */
export const orphanPlace = (comment: InlineComment, round: number): string => {
  const { anchor } = comment;
  const lines = lineRange(anchor.start_line, anchor.end_line, "Line");
  const side = anchor.side === "old" ? " (old side)" : "";
  const when = anchor.snapshot.round === round - 1 ? "the previous round" : `round ${anchor.snapshot.round}`;
  return `${lines}${side} of ${when}`;
};

export const PATCH_NOTE_TEXT: Readonly<Record<NonNullable<ReviewFile["patch_note"]>, string>> = {
  binary: "A binary file; there is no text to show.",
  too_large: "The patch is too large to show.",
  symlink: "A symbolic link; the patch shows its target.",
  submodule: "A submodule; the patch shows the commit it points to.",
  secret: "Likely a secret, so its contents were left out.",
  no_content_change: "Only the mode changed.",
  empty: "An empty file.",
  replaced_characters: "Hidden or reordering characters in this patch were replaced.",
};
