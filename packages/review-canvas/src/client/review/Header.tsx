/**
 * The top of the review page: the bar with the target and the connection, the title with any drift and the rounds as
 * tabs, and the strip under them that names the one thing to do next. The bar and the strip stick on a wide page.
 */
import { useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReviewId } from "../../schema/primitives.ts";
import type { Target } from "../../schema/target.ts";
import type { Thread } from "../../schema/thread.ts";
import { fileElementId } from "../../review/next.ts";
import { count, targetName, threadName, VERDICT_DONE, VERDICT_TEXT } from "../names.ts";
import { CONNECTION_TEXT, connectionAtom } from "../rpc.ts";
import { buttonVariants } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { frame } from "../ui/page.tsx";
import { TargetText, ThreadName } from "../ui/target.tsx";
import { Joined, LineCounts, Prose, Time } from "../ui/text.tsx";
import { toast } from "../ui/toast.tsx";
import { usePage } from "./act.ts";
import { earlierAtom } from "./data.ts";

const LOST =
  "Lost connection to the review server. It stops after a long idle time; ask the agent to run any review-canvas command, such as review-canvas status, to start it again. This page reconnects on its own when the server returns on this port; otherwise open the URL that command prints.";

/** The connection state: quiet while connected, a live region that speaks when the socket is lost. */
const Connection = ({ updated }: { readonly updated: string | undefined }) => {
  const connection = useAtomValue(connectionAtom);
  const lost = CONNECTION_TEXT[connection.state];
  const said = useRef("");
  useEffect(() => {
    if (lost === CONNECTION_TEXT.disconnected && said.current !== lost) toast(LOST, "danger");
    said.current = lost;
  }, [lost]);
  return (
    <span className="text-small text-muted">
      {lost === "" && updated !== undefined ? (
        <span>
          Connected · updated <Time at={updated} />
        </span>
      ) : null}
      <span data-connection role="status" title={lost === "" ? undefined : LOST} className="font-semibold text-warning">
        {lost}
      </span>
    </span>
  );
};

export const TopBar = ({
  target,
  updated,
  onFinish,
}: {
  readonly target: Target;
  readonly updated: string | undefined;
  readonly onFinish: (() => void) | undefined;
}) => {
  const name = targetName(target);
  return (
    <header data-topbar className="z-20 border-b border-separator bg-surface text-small md:sticky md:top-0">
      <div className={cn(frame({ width: "review" }), "flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-1 md:min-h-11")}>
        <div className="flex min-w-0 flex-[1_1_12rem] flex-wrap items-baseline gap-x-2">
          <a href="/" className="text-muted underline underline-offset-3">
            Review canvas
          </a>
          <span aria-hidden="true" className="text-muted">
            /
          </span>
          <TargetText target={target} />
          {name.kind === "pr" ? (
            <a href={name.url} rel="noopener" title="Open the pull request on GitHub" aria-label="Open the pull request on GitHub" className="px-1 text-muted no-underline">
              ↗
            </a>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <Connection updated={updated} />
          {onFinish === undefined ? null : (
            <a
              href="#finish"
              data-open-finish
              onClick={(event) => {
                event.preventDefault();
                onFinish();
              }}
              className={buttonVariants({ variant: "primary", size: "sm" })}
            >
              Finish review
            </a>
          )}
        </div>
      </div>
    </header>
  );
};

/** Who did something: the agents' dot, then the thread's name when there is one, then what it did. */
export const Who = ({ thread, children }: { readonly thread: Thread | undefined; readonly children: React.ReactNode }) => (
  <span className="inline-flex items-baseline gap-1.5">
    <span aria-hidden="true" className="inline-block size-2 rounded-full bg-accent" />
    {thread === undefined ? null : (
      <strong className="text-ink">
        <ThreadName thread={thread} />
      </strong>
    )}
    {children}
  </span>
);

const RoundsLine = ({ id }: { readonly id: ReviewId }) => {
  const { page } = usePage();
  const { state, threads } = page.snapshot;
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const earlier = useAtomValue(earlierAtom({ id, round: page.round.round }));
  const summaries = new Map(
    AsyncResult.value(earlier).pipe(
      Option.map((rounds) => rounds.map((item) => [item.round, item.summary] as const)),
      Option.getOrElse(() => []),
    ),
  );
  const submissionOf = (round: number) => state.submissions.findLast((item) => item.round === round);
  return (
    <>
      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 border-b border-separator text-small">
        {state.rounds.map((round) => {
          const submission = submissionOf(round.round);
          const done = submission === undefined ? undefined : `you ${VERDICT_DONE[submission.verdict]}`;
          if (round.round === page.round.round)
            return (
              <span key={round.round} data-round-current aria-current="true" className="-mb-px border-b-2 border-accent pb-2 font-semibold text-ink">
                Round {round.round} · {done ?? (state.closed_at === undefined ? "open" : "closed")}
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
              Round {round.round} · {done ?? "not finished"} · <Time at={submission?.submitted_at ?? round.published_at} />
              <span aria-hidden="true"> {expanded ? "▴" : "▾"}</span>
            </button>
          );
        })}
      </div>
      {state.rounds
        .filter((round) => round.round !== page.round.round && open.has(round.round))
        .map((round) => {
          const submission = submissionOf(round.round);
          const summary = summaries.get(round.round);
          const publisher = threads.find((item) => item.id === round.thread);
          return (
            <div key={round.round} id={`round-${round.round}-detail`} className="my-3 flex flex-col gap-2 rounded-panel border border-separator bg-surface px-4 py-3">
              <p className="text-small text-muted">
                Round {round.round}, published <Time at={round.published_at} /> by {publisher === undefined ? round.thread : threadName(publisher.label)}
              </p>
              {summary === undefined ? <p className="text-muted">No summary.</p> : <Prose text={summary} />}
              {submission === undefined ? null : (
                <p>
                  <strong>You</strong>{" "}
                  <span className="text-muted">
                    · {VERDICT_TEXT[submission.verdict]} · <Time at={submission.submitted_at} />
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
                <a href={`#${encodeURI(fileElementId(path)).replaceAll("#", "%23")}`} className="text-link underline underline-offset-3">
                  <code>{path}</code>
                </a>
              ) : (
                <code>{path}</code>
              ),
            )}
          />
          {drift.paths.length > shown.length ? ` and ${drift.paths.length - shown.length} more` : ""}
        </>
      )}
      {drift.head_sha === undefined ? null : (
        <>
          {" "}
          <span className="text-muted">· head</span> <code>{drift.head_sha.slice(0, 7)}</code>
        </>
      )}{" "}
      <span className="text-muted">
        · checked <Time at={drift.checked_at} /> · the agents publish a new round with the change.
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
      <h1 className="mb-1.5 text-title leading-tight font-semibold tracking-tight break-words">{input.target.title}</h1>
      <p className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1.5 text-small text-muted">
        <Who thread={publisher}>
          {publisher === undefined ? <strong className="text-ink">{round.thread}</strong> : null} published round {round.round} at{" "}
          <Time at={round.published_at} />
        </Who>
        <span>
          <strong className="text-ink">{count(input.files.length, "file")}</strong> · <LineCounts additions={additions} deletions={deletions} />
        </span>
        <code title={sha}>{sha.slice(0, 7)}</code>
      </p>
      <DriftLine />
      {input.files_complete ? null : <p className="mt-2 text-small text-muted">The file list may be incomplete.</p>}
      <RoundsLine id={id} />
    </header>
  );
};

const Kbd = ({ children }: { readonly children: string }) => (
  <kbd className="inline-block rounded-sm border border-line px-[0.3em] leading-[1.3] font-semibold text-muted">{children}</kbd>
);

export const NextStrip = ({ onGo }: { readonly onGo: () => void }) => {
  const { page } = usePage();
  const { strip } = page;
  const { viewable: total, forYou, waiting } = page.progress;
  const viewed = page.progress.viewed.size;
  return (
    <section
      data-next
      aria-label="Next"
      className="sticky top-(--topbar-height) z-10 col-span-full -mx-6 min-w-0 border-b border-separator bg-raised px-6 text-small max-md:static max-md:-mx-4 max-md:px-4"
    >
      <div className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1">
        {strip.kind === "go" ? (
          <a
            href={`#${encodeURI(strip.next.target).replaceAll("#", "%23")}`}
            data-next-go
            data-target={strip.next.target}
            data-kind={strip.next.kind}
            onClick={(event) => {
              event.preventDefault();
              onGo();
            }}
            className="-ml-2 inline-flex min-h-11 min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 rounded-control px-2 py-1 font-semibold text-ink no-underline hover:bg-subtle"
          >
            <span aria-hidden="true" className="inline-grid size-6 flex-none place-items-center rounded-control bg-accent text-chip text-on-accent">
              →
            </span>
            <span className="min-w-0 break-words">
              {strip.what}
              {strip.code === undefined ? null : (
                <>
                  {" "}
                  <code className="font-semibold">{strip.code}</code>
                </>
              )}
            </span>{" "}
            <span className="min-w-0 font-normal text-muted">
              <span aria-hidden="true">· </span>
              {strip.why}
            </span>
          </a>
        ) : strip.kind === "finished" ? (
          <p className="py-2.5">
            <strong>You finished round {strip.round}</strong>{" "}
            <span className="text-muted">· {VERDICT_TEXT[strip.verdict]} · the agents have the turn</span>
          </p>
        ) : (
          <p className="py-2.5">
            <strong>Closed</strong> <span className="text-muted">· replaced by a fresh start</span>
            {page.snapshot.replaced_by === undefined ? null : (
              <>
                {" "}
                ·{" "}
                <a href={`/reviews/${page.snapshot.replaced_by}`} className="text-link underline underline-offset-3">
                  Open the newer review
                </a>
              </>
            )}
          </p>
        )}
        {strip.kind === "go" ? (
          <span aria-hidden="true" className="text-muted max-md:hidden pointer-coarse:hidden">
            <Kbd>n</Kbd> next · <Kbd>j</Kbd> <Kbd>k</Kbd> stops
          </span>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1">
          <progress
            value={viewed}
            max={Math.max(total, 1)}
            aria-label="Files viewed"
            className="h-1.5 w-30 max-md:hidden appearance-none overflow-hidden rounded-full [&::-moz-progress-bar]:bg-success [&::-webkit-progress-bar]:bg-separator [&::-webkit-progress-value]:bg-success"
          >
            {viewed} of {total}
          </progress>
          <span data-viewed-count>
            <strong>{viewed}</strong> of {total} viewed
          </span>
          {forYou === 0 ? null : (
            <span data-for-you>
              <strong>{forYou}</strong> for you
            </span>
          )}
          {waiting === 0 ? null : <span data-waiting className="text-muted max-md:hidden">{waiting} waiting for agents</span>}
        </div>
      </div>
    </section>
  );
};

/** The sticky bars' heights, for what sticks under them and what the page scrolls to. */
export const useStickyBars = () => {
  useLayoutEffect(() => {
    const measure = () => {
      const bar = document.querySelector<HTMLElement>("[data-topbar]");
      const strip = document.querySelector<HTMLElement>("[data-next]");
      const barSticks = bar !== null && getComputedStyle(bar).position === "sticky";
      const stripSticks = strip !== null && getComputedStyle(strip).position === "sticky";
      const top = barSticks ? (bar?.offsetHeight ?? 0) : 0;
      document.documentElement.style.setProperty("--topbar-height", `${top}px`);
      document.documentElement.style.setProperty("--sticky-top", `${top + (stripSticks ? (strip?.offsetHeight ?? 0) : 0) + 8}px`);
    };
    const observer = new ResizeObserver(measure);
    for (const element of document.querySelectorAll("[data-topbar], [data-next]")) observer.observe(element);
    measure();
    addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      removeEventListener("resize", measure);
    };
  }, []);
};
