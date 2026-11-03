/**
 * Other rounds on the review page: "since my last review", which shows each file's changes since the round of the
 * reviewer's last finished review instead of its whole change, and an earlier round's whole diff, opened read-only
 * from the rounds line. The page compares the rounds it fetched; nothing here changes the review.
 */
import { useAtom, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { ChevronDown } from "lucide-react";
import { useId, useMemo, useState } from "react";
import type { ReviewFile } from "../../schema/input.ts";
import type { ReviewId, RoundNumber } from "../../schema/primitives.ts";
import { parseRows, type RowKind } from "../../review/patch.ts";
import type { ReviewState, Round } from "../../review/queries.ts";
import { type SinceComparison, sinceRound } from "../../review/since.ts";
import { count, lineRange } from "../names.ts";
import { type CallError, failureText } from "../rpc.ts";
import { TOUCH_TARGET } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { LineCounts } from "../ui/text.tsx";
import { usePage } from "./act.ts";
import { roundAtom, sinceAtom } from "./data.ts";
import type { ContextComment, PlacedComment } from "./diff-model.ts";
import { DiffTable, Marker } from "./Diff.tsx";
import { ThreadView } from "./Thread.tsx";
import { type BodyDiff, sinceLastReviewAtom } from "./ui.ts";
import {
  type FileModel,
  fileStatus,
  PATCH_NOTE_TEXT,
  sinceSummary,
} from "./view.ts";

/** No comparison to read: the setting is off, or there is no earlier round. */
const noComparison = Atom.make<
  AsyncResult.AsyncResult<SinceComparison, CallError>
>(AsyncResult.initial());

/**
 * The comparison the setting asks for: off, there is nothing to compare with, or the rounds of the reviewer's last
 * review and of the page, and how far reading them is.
 */
const useComparison = (
  id: ReviewId,
  state: ReviewState,
  round: Round | undefined,
) => {
  const on = useAtomValue(sinceLastReviewAtom);
  const base = sinceRound(state);
  const key =
    on && base !== undefined && round !== undefined
      ? { id, since: base, round: round.round }
      : undefined;
  const result = useAtomValue(
    key === undefined ? noComparison : sinceAtom(key),
  );
  return { key, result };
};

/**
 * The comparison the review page's model takes. `ready` is false while the rounds it compares load: until then the
 * page keeps what it shows. A comparison that failed shows the whole change; the control says why.
 */
export const useSince = (
  id: ReviewId,
  state: ReviewState,
  round: Round | undefined,
): {
  readonly since: SinceComparison | undefined;
  readonly ready: boolean;
} => {
  const { key, result } = useComparison(id, state, round);
  return {
    since: AsyncResult.value(result).pipe(Option.getOrUndefined),
    ready: key === undefined || AsyncResult.isNotInitial(result),
  };
};

/**
 * The one control for "since my last review", under the rounds line: shown while there is an earlier round to compare
 * with, remembered for every review, and with how many files changed since then once it is on.
 */
export const SinceControl = () => {
  const { id, page } = usePage();
  const [on, setOn] = useAtom(sinceLastReviewAtom);
  const { state } = page.snapshot;
  const { result } = useComparison(id, state, page.round);
  const base = sinceRound(state);
  if (base === undefined) return null;
  const reviewed = state.submissions.length > 0;
  return (
    <div
      data-since
      className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-small"
    >
      <label className="flex w-fit items-center gap-2">
        <input
          type="checkbox"
          data-since-last-review
          checked={on}
          onChange={(event) => setOn(event.currentTarget.checked)}
          className="size-4 accent-accent"
        />
        {reviewed
          ? `Only changes since your last review, in round ${base}`
          : `Only changes since round ${base}`}
      </label>
      {!on ? (
        reviewed ? null : (
          <span className="text-muted">
            You have not finished a review yet, so this compares with the round
            before.
          </span>
        )
      ) : AsyncResult.isFailure(result) ? (
        <span role="alert" className="text-warning">
          The rounds did not load, so the page shows the whole change:{" "}
          {failureText(result.cause)}
        </span>
      ) : page.since === undefined ? (
        <span role="status" className="text-muted">
          Comparing with round {base}…
        </span>
      ) : (
        <span data-since-summary className="text-muted">
          {sinceSummary(page.since)}
        </span>
      )}
    </div>
  );
};

/** Where a thread is in the file now: its lines on the side it was made on. */
const threadPlace = (
  model: FileModel,
  thread: PlacedComment | ContextComment,
): string => {
  if ("start_line" in thread)
    return lineRange(thread.start_line, thread.end_line, "Line");
  const old =
    thread.comment.anchor.kind === "patch" &&
    thread.comment.anchor.side === "old";
  const lines = parseRows(model.file.patch ?? "")
    .slice(thread.start, thread.end + 1)
    .map((row) => (old ? row.old : row.new))
    .filter((line) => line !== undefined);
  const first = lines[0];
  const last = lines.at(-1);
  return first === undefined || last === undefined
    ? "In the whole change"
    : `${lineRange(first, last, "Line")}${old ? " (old side)" : ""}`;
};

/**
 * A changed file's body while the page shows only what changed since the last review: that change, read-only, then
 * the file's threads by the lines they are on, as they show in the whole change.
 */
export const SinceChanges = ({
  model,
  patch,
  body,
}: {
  readonly model: FileModel;
  readonly patch: string;
  /** The diff the table records the changes it shows of. */
  readonly body: BodyDiff;
}) => {
  const threads = [...model.placed, ...model.context];
  return (
    <>
      <DiffTable model={model} split={false} patch={patch} body={body} />
      {threads.length === 0 ? null : (
        <div data-since-threads className="border-t border-separator">
          {threads.map((thread) => (
            <div key={thread.comment.id} className="px-3 py-3">
              <p className="mb-2 text-small text-muted">
                {threadPlace(model, thread)}
              </p>
              <ThreadView comment={thread.comment} />
            </div>
          ))}
        </div>
      )}
    </>
  );
};

const ROW_TONE: Readonly<Record<RowKind, string>> = {
  add: "bg-diff-addition",
  del: "bg-diff-deletion",
  context: "",
  hunk: "bg-surface text-muted",
  meta: "bg-surface text-muted",
};

const NUMBER =
  "w-px pr-1 pl-3 text-right whitespace-nowrap text-muted tabular-nums select-none max-md:pl-1";

/** A patch as plain rows, read-only: both line numbers, the marker, and the source. */
const PatchTable = ({
  patch,
  label,
}: {
  readonly patch: string;
  readonly label: string;
}) => {
  const rows = useMemo(() => parseRows(patch), [patch]);
  return (
    <div
      role="group"
      aria-label={label}
      tabIndex={0}
      className="overflow-x-auto bg-code focus-visible:-outline-offset-2"
    >
      <table className="w-full border-collapse font-mono text-technical leading-6">
        <thead className="sr-only">
          <tr>
            <th>Old line</th>
            <th>New line</th>
            <th>Change</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.index}
              data-kind={row.kind}
              className={ROW_TONE[row.kind]}
            >
              <td className={NUMBER}>{row.old ?? ""}</td>
              <td className={NUMBER}>{row.new ?? ""}</td>
              <td className="w-px px-1 text-center whitespace-nowrap select-none">
                <Marker kind={row.kind} />
              </td>
              <td className="pr-4 whitespace-pre">
                <code
                  className={
                    row.kind === "hunk" || row.kind === "meta"
                      ? "text-technical"
                      : "text-ink"
                  }
                >
                  {row.content}
                </code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

/** One file of an earlier round: its path, what it was, its counts, and its patch or why there is none. */
const RoundFile = ({
  round,
  file,
}: {
  readonly round: RoundNumber;
  readonly file: ReviewFile;
}) => {
  const status = fileStatus(file, false, undefined);
  return (
    <article
      data-round-file={file.path}
      className="overflow-hidden rounded-control border border-separator bg-raised"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-separator px-2 py-1.5">
        <h4 className="min-w-0 text-technical font-normal">
          <code className="break-all">{file.path}</code>
        </h4>
        {status === undefined ? null : (
          <span className="text-small text-muted">{status.text}</span>
        )}
        {file.patch === undefined ? null : (
          <LineCounts
            additions={file.additions}
            deletions={file.deletions}
            className="ml-auto text-technical"
          />
        )}
      </header>
      {file.patch_note === undefined ? null : (
        <p className="px-4 py-2 text-small text-muted">
          {PATCH_NOTE_TEXT[file.patch_note]}
        </p>
      )}
      {file.patch === undefined ? null : (
        <PatchTable
          patch={file.patch}
          label={`Diff of ${file.path} in round ${round}`}
        />
      )}
    </article>
  );
};

/** An earlier round's whole diff as it was published, read-only: comments and marks belong to the current round. */
const RoundDiff = ({
  id,
  round,
}: {
  readonly id: string;
  readonly round: RoundNumber;
}) => {
  const { id: review } = usePage();
  const result = useAtomValue(roundAtom({ id: review, round }));
  const view = AsyncResult.value(result).pipe(Option.getOrUndefined);
  if (view === undefined)
    return AsyncResult.isFailure(result) ? (
      <p id={id} role="alert" className="text-small">
        Round {round} did not load: {failureText(result.cause)}
      </p>
    ) : (
      <p id={id} role="status" className="text-small text-muted">
        Loading round {round}…
      </p>
    );
  return (
    <div id={id} data-round-diff={round} className="flex flex-col gap-2">
      <p className="text-small text-muted">
        Round {round}’s whole change, {count(view.input.files.length, "file")},
        read-only.
      </p>
      {view.input.files.map((file) => (
        <RoundFile key={file.path} round={round} file={file} />
      ))}
    </div>
  );
};

/** In an earlier round's line: a button that opens that round's whole diff under it, and closes it. */
export const RoundDiffToggle = ({ round }: { readonly round: RoundNumber }) => {
  const [open, setOpen] = useState(false);
  const panel = useId();
  return (
    <>
      <button
        type="button"
        data-round-diff-toggle={round}
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen(!open)}
        className={cn(
          TOUCH_TARGET,
          "inline-flex w-fit items-center gap-1 text-small font-medium text-link hover:underline",
        )}
      >
        {open ? `Hide round ${round}’s diff` : `Show round ${round}’s diff`}
        <ChevronDown
          aria-hidden="true"
          className={cn("size-3.5 transition-transform", !open && "-rotate-90")}
        />
      </button>
      {open ? <RoundDiff id={panel} round={round} /> : null}
    </>
  );
};
