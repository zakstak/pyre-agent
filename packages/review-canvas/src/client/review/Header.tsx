/** The top of the review page: its bar, and under it the title with any drift and the rounds as tabs. */
import { useAtom, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { ArrowUpRight, ChevronDown } from "lucide-react";
import { useState } from "react";
import type { ReviewId } from "../../schema/primitives.ts";
import type { Target } from "../../schema/target.ts";
import type { Thread } from "../../schema/thread.ts";
import { fileElementId } from "../../review/next.ts";
import { count, targetName, VERDICT_DONE, VERDICT_TEXT } from "../names.ts";
import { cn } from "../ui/cn.ts";
import { TopBar } from "../ui/page.tsx";
import { Segmented } from "../ui/segmented.tsx";
import { TargetText } from "../ui/target.tsx";
import { Joined, LineCounts, Prose, Time } from "../ui/text.tsx";
import { AgentVoice, Voice } from "../ui/voice.tsx";
import { usePage } from "./act.ts";
import { earlierAtom } from "./data.ts";
import { hashOf } from "./places.ts";
import { viewAtom } from "./ui.ts";

/** Whether the review reads guided or as source. A narrow page reads guided, so it shows no choice. */
export const ViewControl = () => {
  const [view, setView] = useAtom(viewAtom);
  return (
    <Segmented
      label="View"
      attribute="data-view"
      choices={[
        ["guided", "Guided"],
        ["source", "Source"],
      ]}
      value={view}
      onChange={setView}
      className="max-md:hidden"
    />
  );
};

/**
 * The top bar of a review: the target as the page's place and a link to the pull request, and the page's choices,
 * such as the view, before the connection state.
 */
export const ReviewBar = ({
  target,
  updated,
  children,
}: {
  readonly target: Target;
  readonly updated: string | undefined;
  readonly children?: React.ReactNode;
}) => {
  const name = targetName(target);
  return (
    <TopBar
      width="review"
      updated={updated}
      controls={children}
      place={
        <>
          <TargetText target={target} />
          {name.kind === "pr" ? (
            <a
              href={name.url}
              rel="noopener"
              title={`Open on ${new URL(name.url).host}`}
              aria-label={`Open on ${new URL(name.url).host}`}
              className="inline-flex self-center px-1 text-muted no-underline"
            >
              <ArrowUpRight aria-hidden="true" className="size-3.5" />
            </a>
          ) : null}
        </>
      }
    />
  );
};

/** What an agent did: its voice, named by its thread or else by `id`, then what it did. */
export const Who = ({
  thread,
  id,
  children,
}: {
  readonly thread: Thread | undefined;
  readonly id: string;
  readonly children: React.ReactNode;
}) => (
  <span className="inline-flex flex-wrap items-center gap-x-1.5">
    {thread === undefined ? (
      <Voice kind="agent" name={id} />
    ) : (
      <AgentVoice label={thread.label} />
    )}
    <span>{children}</span>
  </span>
);

/** The agent's narration, as a kicker over it: the voice of the thread that published the round, then what it is. */
export const Narration = ({
  children,
  className,
}: {
  readonly children: React.ReactNode;
  readonly className?: string;
}) => {
  const { page } = usePage();
  const publisher = page.snapshot.threads.find(
    (item) => item.id === page.round.thread,
  );
  return (
    <p className={cn("text-small text-muted", className)}>
      <Who thread={publisher} id={page.round.thread}>
        {children}
      </Who>
    </p>
  );
};

const RoundsLine = ({ id }: { readonly id: ReviewId }) => {
  const { page } = usePage();
  const { state, threads } = page.snapshot;
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const earlier = useAtomValue(earlierAtom({ id, round: page.round.round }));
  const summaries = new Map(
    AsyncResult.value(earlier).pipe(
      Option.map((rounds) =>
        rounds.map((item) => [item.round, item.summary] as const),
      ),
      Option.getOrElse(() => []),
    ),
  );
  const submissionOf = (round: number) =>
    state.submissions.findLast((item) => item.round === round);
  return (
    <>
      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 border-b border-separator text-small">
        {state.rounds.map((round) => {
          const submission = submissionOf(round.round);
          const done =
            submission === undefined
              ? undefined
              : `you ${VERDICT_DONE[submission.verdict]}`;
          if (round.round === page.round.round)
            return (
              <span
                key={round.round}
                data-round-current
                aria-current="true"
                className="-mb-px border-b-2 border-accent pb-2 font-semibold text-ink"
              >
                Round {round.round} ·{" "}
                {done ?? (state.closed_at === undefined ? "open" : "closed")}
              </span>
            );
          const expanded = open.has(round.round);
          return (
            <button
              key={round.round}
              type="button"
              aria-expanded={expanded}
              aria-controls={`round-${round.round}-detail`}
              onClick={() =>
                setOpen((now) => {
                  const next = new Set(now);
                  if (expanded) next.delete(round.round);
                  else next.add(round.round);
                  return next;
                })
              }
              className="pb-2 text-muted hover:text-ink"
            >
              Round {round.round} · {done ?? "not finished"} ·{" "}
              <Time at={submission?.submitted_at ?? round.published_at} />
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  "ml-1 inline size-3.5 align-[-0.125em] transition-transform",
                  !expanded && "-rotate-90",
                )}
              />
            </button>
          );
        })}
      </div>
      {state.rounds
        .filter(
          (round) => round.round !== page.round.round && open.has(round.round),
        )
        .map((round) => {
          const submission = submissionOf(round.round);
          const summary = summaries.get(round.round);
          const publisher = threads.find((item) => item.id === round.thread);
          return (
            <div
              key={round.round}
              id={`round-${round.round}-detail`}
              className="my-3 flex flex-col gap-2 rounded-panel bg-surface px-4 py-3"
            >
              <p className="text-small text-muted">
                <Who thread={publisher} id={round.thread}>
                  published round {round.round} at{" "}
                  <Time at={round.published_at} />
                </Who>
              </p>
              {summary === undefined ? (
                <p className="text-muted">No summary.</p>
              ) : (
                <Prose text={summary} />
              )}
              {submission === undefined ? null : (
                <p>
                  <Voice kind="you" name="You" />{" "}
                  <span className="text-muted">
                    · {VERDICT_TEXT[submission.verdict]} ·{" "}
                    <Time at={submission.submitted_at} />
                  </span>
                  {submission.body.trim() === "" ? null : (
                    <>
                      <br />
                      {submission.body}
                    </>
                  )}
                </p>
              )}
            </div>
          );
        })}
    </>
  );
};

/** What an agent found changed since this round, as one line until the next round replaces it. */
const DriftLine = () => {
  const { page } = usePage();
  const drift = page.snapshot.state.drift;
  if (drift === undefined || drift.round !== page.round.round) return null;
  const shown = drift.paths.slice(0, 4);
  return (
    <p id="drift" className="mt-2 text-small">
      <strong className="text-warning">Changed since this round:</strong>{" "}
      {drift.paths.length === 0 ? (
        <span className="text-muted">the code</span>
      ) : (
        <>
          <Joined
            items={shown.map((path) =>
              page.files.has(path) ? (
                <a
                  href={hashOf(fileElementId(path))}
                  className="text-link underline underline-offset-3"
                >
                  <code>{path}</code>
                </a>
              ) : (
                <code>{path}</code>
              ),
            )}
          />
          {drift.paths.length > shown.length
            ? ` and ${drift.paths.length - shown.length} more`
            : ""}
        </>
      )}
      {drift.head_sha === undefined ? null : (
        <>
          {" "}
          <span className="text-muted">· head</span>{" "}
          <code>{drift.head_sha.slice(0, 7)}</code>
        </>
      )}{" "}
      <span className="text-muted">
        · checked <Time at={drift.checked_at} /> · the agents publish a new
        round with the change.
      </span>
    </p>
  );
};

export const Title = ({ id }: { readonly id: ReviewId }) => {
  const { page } = usePage();
  const { input, round, snapshot } = page;
  const publisher = snapshot.threads.find((item) => item.id === round.thread);
  const additions = input.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = input.files.reduce((sum, file) => sum + file.deletions, 0);
  const sha = input.target.head_sha;
  return (
    <header className="col-span-full min-w-0 pt-6">
      <h1 className="mb-1.5 text-title leading-tight font-semibold tracking-tight break-words">
        {input.target.title}
      </h1>
      <p className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1.5 text-small text-muted">
        <Who thread={publisher} id={round.thread}>
          published round {round.round} at <Time at={round.published_at} />
        </Who>
        <span>
          <strong className="text-ink">
            {count(input.files.length, "file")}
          </strong>{" "}
          · <LineCounts additions={additions} deletions={deletions} />
        </span>
        <code title={sha}>{sha.slice(0, 7)}</code>
      </p>
      <DriftLine />
      {input.files_complete ? null : (
        <p className="mt-2 text-small text-muted">
          The file list may be incomplete.
        </p>
      )}
      <RoundsLine id={id} />
    </header>
  );
};
