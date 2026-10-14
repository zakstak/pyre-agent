/**
 * The review page: one scroll in the order the agent's stops tell the story. Each stop is a section with the agent's
 * prose and the files it owns as whole diffs, the notes in the code; the conversation sits under the rows it is about;
 * the whole change and the finish come last. A strip under the title always names the one thing to do next.
 */
import { RegistryContext, useAtom, useAtomValue } from "@effect/atom-react";
import { Cause, Exit, Option, Schema } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReviewInput } from "../../schema/input.ts";
import { type ReviewId, RoundNumber } from "../../schema/primitives.ts";
import { Refused, type ReviewSnapshot, type RoundView } from "../../schema/rpc.ts";
import type { Target } from "../../schema/target.ts";
import type { Thread } from "../../schema/thread.ts";
import { fileElementId } from "../../review/next.ts";
import type { Round } from "../../review/queries.ts";
import { count, shortPath, targetName, threadName, VERDICT_DONE, VERDICT_TEXT } from "../names.ts";
import { connectionAtom } from "../rpc.ts";
import { buttonVariants } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Prose, Time } from "../ui/text.tsx";
import { TargetText } from "../ui/target.tsx";
import { ThemeControl } from "../ui/theme.tsx";
import { toast } from "../ui/toast.tsx";
import { failureMessage, ReviewContext, useImport, usePage } from "./act.ts";
import { earlierAtom, reviewAtom, roundAtom } from "./data.ts";
import { useNavigate } from "./navigate.ts";
import { Departed, Finish, General, StopSection } from "./Sections.tsx";
import { draftsAtom, foldsAtom, layoutAtom, NARROW_QUERY, reattachAtom, seenAtom, stashAtom, WIDE_QUERY } from "./ui.ts";
import { type PageModel, pageModel } from "./view.ts";

const LOST =
  "Lost connection to the review server. It stops after a long idle time; ask the agent to run any review-canvas command, such as review-canvas status, to start it again. This page reconnects on its own when the server returns on this port; otherwise open the URL that command prints.";

const useMedia = (query: string) => {
  const media = useMemo(() => matchMedia(query), [query]);
  return useSyncExternalStore(
    (change) => {
      media.addEventListener("change", change);
      return () => media.removeEventListener("change", change);
    },
    () => media.matches,
  );
};

// ------------------------------------------------------------------------------------------------------- top bar

/** The connection state: quiet while connected, a live region that speaks when the socket is lost. */
const Connection = ({ updated }: { readonly updated: string | undefined }) => {
  const connection = useAtomValue(connectionAtom);
  const lost = connection.state === "reconnecting" ? "Reconnecting…" : connection.state === "disconnected" ? "Disconnected" : "";
  const said = useRef("");
  useEffect(() => {
    if (lost === "Disconnected" && said.current !== lost) toast(LOST, "danger");
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

const TopBar = ({
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
    <header
      data-topbar
      className="z-20 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-separator bg-surface px-5 py-1 text-small md:sticky md:top-0 md:min-h-11"
    >
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
    </header>
  );
};

/** A feedback file the reviewer chose, imported through the server's checks, with what it added and left out. */
const ImportFeedback = () => {
  const runImport = useImport();
  return (
    <label className="cursor-pointer font-normal underline underline-offset-3">
      Import feedback
      <input
        type="file"
        accept="application/json,.json"
        data-import
        className="sr-only"
        onChange={async (event) => {
          const input = event.currentTarget;
          const file = input.files?.[0];
          input.value = "";
          if (file === undefined) return;
          const exit = await runImport(await file.text());
          if (Exit.isFailure(exit)) return toast(`Not imported: ${failureMessage(exit.cause)}`, "danger");
          const report = exit.value;
          const added = `Imported ${count(report.comments, "comment")}, ${count(report.replies, "reply", "replies")}, and ${count(report.approvals, "approval")}.`;
          const already = report.already === 0 ? "" : ` ${report.already} already here.`;
          toast(`${added}${already}${report.skipped.length === 0 ? "" : ` ${report.skipped.join(" ")}`}`);
        }}
      />
    </label>
  );
};

/** The footer: the theme, and for a review with a round, its feedback out and in. Import needs the page's context. */
const Footer = ({ id, round, writable }: { readonly id: ReviewId; readonly round: boolean; readonly writable: boolean }) => (
  <footer className="mt-16 flex flex-wrap items-center gap-x-6 gap-y-2 text-small text-muted">
    <ThemeControl />
    {round ? (
      <a href={`/reviews/${id}/feedback.json`} download className="underline underline-offset-3">
        Export feedback
      </a>
    ) : null}
    {round && writable ? <ImportFeedback /> : null}
    <code className="text-technical">{id}</code>
  </footer>
);

const Frame = ({ children }: { readonly children: React.ReactNode }) => (
  <div className="mx-auto grid max-w-[96rem] grid-cols-1 gap-x-8 px-5 pb-16 lg:grid-cols-[15.5rem_minmax(0,1fr)]">{children}</div>
);

const Who = ({ thread, children }: { readonly thread: Thread | undefined; readonly children: React.ReactNode }) => (
  <span className="inline-flex items-baseline gap-1.5">
    <span aria-hidden="true" className="inline-block size-2 rounded-full bg-accent" />
    {thread === undefined ? null : (
      <strong className="text-ink" title={thread.label === threadName(thread.label) ? undefined : thread.label}>
        {threadName(thread.label)}
      </strong>
    )}
    {children}
  </span>
);

// --------------------------------------------------------------------------------------------------------- waiting

/** A review no thread has published a round to yet: the title, one sentence, and the footer. */
const Waiting = ({ snapshot }: { readonly snapshot: ReviewSnapshot }) => {
  const names = snapshot.threads.map((item) => threadName(item.label));
  const who =
    names.length === 0 ? "the agents" : names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  const first = snapshot.threads[0];
  useEffect(() => {
    document.title = `Waiting for the first round · ${snapshot.state.target.title} · Review canvas`;
  }, [snapshot.state.target.title]);
  return (
    <>
      <TopBar target={snapshot.state.target} updated={snapshot.state.created_at} onFinish={undefined} />
      <Frame>
        <header className="col-span-full pt-5">
          <h1 className="text-title font-semibold tracking-tight">{snapshot.state.target.title}</h1>
          <p className="mt-1.5 flex flex-wrap items-baseline gap-x-3.5 text-small text-muted">
            {first === undefined ? null : (
              <Who thread={first}>
                started this review at <Time at={snapshot.state.created_at} />
              </Who>
            )}
            <TargetText target={snapshot.state.target} />
          </p>
        </header>
        <main id="main" tabIndex={-1} className="col-span-full pt-8">
          <p className="max-w-reading">Waiting for {who}’s first round. This page updates itself.</p>
        </main>
        <div className="col-span-full">
          <Footer id={snapshot.state.id} round={false} writable={false} />
        </div>
      </Frame>
    </>
  );
};

// ------------------------------------------------------------------------------------------------------------ title

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
      <div data-rounds className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-small">
        {state.rounds.map((round) => {
          const submission = submissionOf(round.round);
          const done = submission === undefined ? undefined : VERDICT_DONE[submission.verdict];
          if (round.round === page.round.round)
            return (
              <span key={round.round} data-round-current aria-current="true" className="border-b-2 border-accent pb-1 font-semibold text-ink">
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
              className="cursor-pointer pb-1 text-muted hover:text-ink"
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
            <div key={round.round} id={`round-${round.round}-detail`} className="mt-2 flex flex-col gap-2 rounded-panel border border-separator bg-surface px-4 py-3">
              <p className="text-small text-muted">
                Round {round.round}, published <Time at={round.published_at} /> by {publisher === undefined ? round.thread : threadName(publisher.label)}
              </p>
              {summary === undefined ? <p className="text-muted">No summary.</p> : <Prose text={summary} />}
              {submission === undefined ? null : (
                <p className="max-w-reading">
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
          {shown.map((path, at) => (
            <span key={path}>
              {at === 0 ? null : ", "}
              {page.files.has(path) ? (
                <a href={`#${encodeURI(fileElementId(path)).replaceAll("#", "%23")}`} className="text-link underline underline-offset-3">
                  <code>{path}</code>
                </a>
              ) : (
                <code>{path}</code>
              )}
            </span>
          ))}
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

const Title = ({ id }: { readonly id: ReviewId }) => {
  const { page } = usePage();
  const { input, round, snapshot } = page;
  const publisher = snapshot.threads.find((item) => item.id === round.thread);
  const additions = input.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = input.files.reduce((sum, file) => sum + file.deletions, 0);
  const sha = input.target.head_sha;
  return (
    <header className="col-span-full min-w-0 pt-5">
      <h1 className="mb-1.5 text-title leading-tight font-semibold tracking-tight break-words">{input.target.title}</h1>
      <p className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1.5 text-small text-muted">
        <Who thread={publisher}>
          {publisher === undefined ? <strong className="text-ink">{round.thread}</strong> : null} published round {round.round} at{" "}
          <Time at={round.published_at} />
        </Who>
        <span>
          <strong className="text-ink">{count(input.files.length, "file")}</strong> ·{" "}
          <code>
            <span className="text-success">+{additions}</span> <span className="text-danger">−{deletions}</span>
          </code>
        </span>
        <code title={sha}>{sha.slice(0, 7)}</code>
      </p>
      <RoundsLine id={id} />
      <DriftLine />
      {input.files_complete ? null : <p className="mt-2 text-small text-muted">The file list may be incomplete.</p>}
    </header>
  );
};

// ------------------------------------------------------------------------------------------------------ next strip

const Kbd = ({ children }: { readonly children: string }) => (
  <kbd className="inline-block rounded-sm border border-line px-[0.3em] leading-[1.3] font-semibold text-muted">{children}</kbd>
);

const NextStrip = ({ onGo }: { readonly onGo: () => void }) => {
  const { page } = usePage();
  const { strip } = page;
  const { viewable: total, forYou, waiting } = page.progress;
  const viewed = page.progress.viewed.size;
  return (
    <section
      data-next
      aria-label="Next"
      className="sticky top-(--topbar-height) z-10 col-span-full mt-3.5 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 rounded-control border border-separator bg-raised py-1 pr-3 pl-2 text-small max-md:static"
    >
      {strip.kind === "go" ? (
        <a
          href={`#${strip.next.target}`}
          data-next-go
          data-target={strip.next.target}
          data-kind={strip.next.kind}
          onClick={(event) => {
            event.preventDefault();
            onGo();
          }}
          className="inline-flex min-h-11 min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 rounded-control px-2 py-1 font-semibold text-ink no-underline hover:bg-subtle"
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
        <p className="px-2 py-2.5">
          <strong>You finished round {strip.round}</strong>{" "}
          <span className="text-muted">· {VERDICT_TEXT[strip.verdict]} · the agents have the turn</span>
        </p>
      ) : (
        <p className="px-2 py-2.5">
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
        <span aria-hidden="true" className="text-muted max-lg:hidden">
          <Kbd>n</Kbd> next · <Kbd>j</Kbd> <Kbd>k</Kbd> stops
        </span>
      ) : null}
      <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1">
        <progress
          value={viewed}
          max={Math.max(total, 1)}
          aria-label="Files viewed"
          className="h-1.5 w-30 appearance-none overflow-hidden rounded-full [&::-moz-progress-bar]:bg-success [&::-webkit-progress-bar]:bg-separator [&::-webkit-progress-value]:bg-success"
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
        {waiting === 0 ? null : <span data-waiting className="text-muted">{waiting} waiting for agents</span>}
      </div>
    </section>
  );
};

// -------------------------------------------------------------------------------------------------------- contents

const Contents = ({
  current,
  read,
  onStop,
  onFile,
}: {
  readonly current: string | undefined;
  readonly read: ReadonlySet<number>;
  readonly onStop: (index: number) => void;
  readonly onFile: (path: string) => void;
}) => {
  const { page } = usePage();
  const [layout, setLayout] = useAtom(layoutAtom);
  const wide = useMedia(WIDE_QUERY);
  const [open, setOpen] = useState(false);
  const viewed = page.progress.viewed.size;
  const total = page.progress.viewable;
  const nav = useRef<HTMLElement>(null);
  // A wide page keeps the spied row in view in the pane.
  useEffect(() => {
    if (!wide) return;
    nav.current?.querySelector<HTMLElement>("[aria-current='location']")?.scrollIntoView({ block: "nearest" });
  }, [current, wide]);
  const list = (
    <nav ref={nav} aria-label="Stops and files" className="text-small">
      <ol className="m-0 flex list-none flex-col p-0">
        {page.stops.map((stop) => (
          <li key={stop.index} className="mt-2 first:mt-0">
            <a
              href={`#stop-${stop.index + 1}`}
              data-stop-link={stop.index}
              data-read={read.has(stop.index) ? "" : undefined}
              aria-current={current === `stop:${stop.index}` ? "location" : undefined}
              onClick={(event) => {
                event.preventDefault();
                setOpen(false);
                onStop(stop.index);
              }}
              className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-baseline gap-x-1.5 rounded-control px-1 py-1 font-semibold text-ink no-underline hover:bg-subtle aria-[current]:bg-selected"
            >
              <span className={cn("font-mono text-technical font-normal", read.has(stop.index) ? "text-accent" : "text-muted")}>{stop.index + 1}</span>
              <span className="min-w-0">{stop.title}</span>
              <span className="font-normal text-muted">{stop.owns.length}</span>
            </a>
            {stop.owns.length === 0 ? null : (
              <ol className="m-0 list-none p-0">
                {stop.owns.map((path) => {
                  const model = page.files.get(path);
                  if (model === undefined) return null;
                  const name = shortPath(path);
                  return (
                    <li key={path} className="m-0">
                      <a
                        href={`#${encodeURI(fileElementId(path)).replaceAll("#", "%23")}`}
                        data-toc-file={path}
                        title={path}
                        aria-current={current === `file:${path}` ? "location" : undefined}
                        onClick={(event) => {
                          event.preventDefault();
                          setOpen(false);
                          onFile(path);
                        }}
                        className={cn(
                          "flex h-7 items-center gap-2 rounded-control pr-1 pl-7 font-mono text-technical no-underline hover:bg-subtle aria-[current]:bg-selected",
                          model.approved ? "text-muted" : "text-ink",
                        )}
                      >
                        {/*
                          The folder and name when both fit, else the name alone, cut at its end; never part of the
                          folder. The name comes first in a wrapping line laid out right to left and packed to the
                          left, so the folder is what wraps, onto a second line the row clips.
                        */}
                        <span className="flex max-h-7 min-w-0 flex-1 flex-row-reverse flex-wrap justify-end overflow-hidden leading-7 whitespace-nowrap">
                          <span className="flex-none text-muted">{name.dir}</span>
                          <span className="-order-1 min-w-0 truncate">{name.base}</span>
                        </span>
                        {model.approved ? (
                          <span aria-label="viewed" className="text-ink">
                            ✓
                          </span>
                        ) : model.open > 0 ? (
                          <span aria-label={count(model.open, "open comment")} className="inline-flex items-center gap-1 text-ink">
                            <span aria-hidden="true" className="inline-block size-1.5 rounded-full bg-accent" />
                            {model.open}
                          </span>
                        ) : null}
                      </a>
                    </li>
                  );
                })}
              </ol>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
  const foot = (
    <div className="mt-4 flex items-center justify-between border-t border-separator pt-4 text-small">
      <div role="group" aria-label="Diff layout" className="inline-flex overflow-hidden rounded-control border border-line max-md:hidden">
        {(["unified", "split"] as const).map((choice) => (
          <button
            key={choice}
            type="button"
            data-layout={choice}
            aria-pressed={layout === choice}
            onClick={() => setLayout(choice)}
            className={cn(
              "h-7 cursor-pointer px-2.5 font-medium capitalize",
              layout === choice ? "bg-selected text-ink shadow-pressed" : "bg-raised text-muted hover:bg-subtle",
            )}
          >
            {choice}
          </button>
        ))}
      </div>
      <span className="text-muted">
        {viewed} / {total}
      </span>
    </div>
  );
  return (
    <div data-contents className="min-w-0 lg:sticky lg:top-(--sticky-top) lg:mt-6 lg:max-h-[calc(100vh-var(--sticky-top)-1rem)] lg:self-start lg:overflow-y-auto">
      {wide ? (
        <>
          {list}
          {foot}
        </>
      ) : (
        <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="mt-4 rounded-panel border border-separator bg-surface px-3">
          <summary className="flex min-h-11 cursor-pointer items-center font-semibold">
            Contents · {viewed} / {total}
          </summary>
          <div className="pb-3">
            {list}
            {foot}
          </div>
        </details>
      )}
    </div>
  );
};

// ------------------------------------------------------------------------------------------------------------ page

/** The sticky bars' heights, for what sticks under them and what the page scrolls to. */
const useStickyBars = () => {
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
  });
};

const Review = ({ id, page }: { readonly id: ReviewId; readonly page: PageModel }) => {
  const key = { id, round: page.round.round };
  const navigate = useNavigate(key, page);
  const registry = useContext(RegistryContext);
  const general = useRef<HTMLTextAreaElement>(null);
  const read = new Set(useAtomValue(seenAtom(key)));
  const [layout] = useAtom(layoutAtom);
  const narrow = useMedia(NARROW_QUERY);
  const split = layout === "split" && !narrow;
  const [current, setCurrent] = useState<string | undefined>(undefined);
  useStickyBars();

  useEffect(() => {
    document.title = `${page.input.target.title} · Review canvas`;
  }, [page.input.target.title]);

  // The hash, once the page first shows and whenever it changes.
  const applied = useRef(false);
  useEffect(() => {
    if (!applied.current) {
      applied.current = true;
      void navigate.applyHash();
    }
    const change = () => void navigate.applyHash();
    addEventListener("hashchange", change);
    return () => removeEventListener("hashchange", change);
  }, [navigate]);

  // The scroll-spy, on scroll and resize, a frame at a time.
  useEffect(() => {
    let queued = false;
    const run = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        setCurrent(navigate.spy());
      });
    };
    run();
    addEventListener("scroll", run, { passive: true });
    addEventListener("resize", run);
    return () => {
      removeEventListener("scroll", run);
      removeEventListener("resize", run);
    };
  }, [navigate]);

  // J and K between stops, N for the next thing to do, Esc to stop moving a comment.
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape" && registry.get(reattachAtom) !== undefined) {
        registry.set(reattachAtom, undefined);
        toast("The comment stays where it was.");
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("textarea, input, select, [contenteditable='true']") !== null) return;
      const key = event.key.toLowerCase();
      if (key === "j") void navigate.next();
      else if (key === "k") void navigate.previous();
      else if (key === "n") void navigate.goNext();
      else return;
      event.preventDefault();
    };
    document.addEventListener("keydown", keys);
    return () => document.removeEventListener("keydown", keys);
  }, [navigate, registry]);

  // A new round: say so, keep the files that were open, and take drafts off patches that changed.
  const before = useRef<{ readonly round: RoundNumber; readonly open: ReadonlySet<string> } | undefined>(undefined);
  useEffect(() => {
    const open = new Set(
      [...document.querySelectorAll<HTMLElement>("article[data-path][data-folded='false']")].map((article) => article.dataset.path ?? ""),
    );
    const was = before.current;
    before.current = { round: page.round.round, open };
    if (was === undefined || was.round === page.round.round) return;
    const finish = document.getElementById("finish");
    const kept = finish?.dataset.round;
    toast(
      kept !== undefined && kept !== String(page.round.round)
        ? `Round ${page.round.round} was published. Your finish still names round ${kept}.`
        : `Round ${page.round.round} was published.`,
    );
    const folds = registry.get(foldsAtom(key));
    const carried = { ...folds };
    const paths = new Set<string>(page.input.files.map((file) => file.path));
    for (const path of was.open) if (paths.has(path) && carried[path] === undefined) carried[path] = "open";
    registry.set(foldsAtom(key), carried);
  });
  useEffect(() => {
    const drafts = registry.get(draftsAtom);
    const fits = (draft: (typeof drafts)[number]) => {
      const model = [...page.files.values()].find((item) => item.file.path === draft.path);
      return model !== undefined && model.digest === draft.digest;
    };
    const lost = drafts.filter((draft) => !draft.submitting && !fits(draft));
    if (lost.length === 0) return;
    registry.set(draftsAtom, drafts.filter((draft) => !lost.includes(draft)));
    const text = lost.map((draft) => draft.body).find((body) => body.trim() !== "");
    if (text !== undefined) {
      registry.set(stashAtom, text);
      toast(
        "The code under your comment changed in a new round. Your text is kept: select lines to comment on, and it fills the new comment.",
        "danger",
      );
    }
  }, [page.files, registry]);

  const ask = (question: string) => {
    const area = general.current;
    if (area === null) return;
    const now = area.value;
    const next = now.startsWith(question) ? now : now === "" ? question : `${question}\n\n${now}`;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(area, next);
    area.dispatchEvent(new Event("input", { bubbles: true }));
    area.scrollIntoView({ block: "center" });
    area.focus();
    area.setSelectionRange(next.length, next.length);
  };

  return (
    <ReviewContext.Provider value={{ id, page }}>
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-control focus:border focus:border-line focus:bg-raised focus:px-3 focus:py-2">
        Skip to content
      </a>
      <TopBar target={page.snapshot.state.target} updated={page.updated} onFinish={page.writable && !page.finished ? () => void navigate.goFinish() : undefined} />
      <Frame>
        <Title id={id} />
        <NextStrip onGo={() => void navigate.goNext()} />
        <Contents current={current} read={read} onStop={(index) => void navigate.showStop(index)} onFile={(path) => {
          history.replaceState(null, "", `#${encodeURI(fileElementId(path)).replaceAll("#", "%23")}`);
          void navigate.showFile(path);
        }} />
        <main id="main" tabIndex={-1} className="min-w-0 pt-8 outline-none">
          {page.input.summary === undefined ? null : (
            <div className="mb-10">
              <Prose text={page.input.summary} />
            </div>
          )}
          {page.stops.map((stop) => (
            <StopSection key={stop.index} stop={stop} split={split} onFlash={(path, index, start, end) => void navigate.flash(path, index, start, end)} onAsk={ask} />
          ))}
          <Departed />
          <General textarea={general} />
          <Finish key={page.writable ? "open" : "closed"} />
        </main>
        <div className="col-span-full">
          <Footer id={id} round writable={page.writable} />
        </div>
      </Frame>
    </ReviewContext.Provider>
  );
};

const Message = ({ title, children }: { readonly title: string; readonly children?: React.ReactNode }) => (
  <main className="mx-auto max-w-work p-8">
    <h1 className="text-title font-semibold">{title}</h1>
    {children === undefined ? null : <div className="mt-2 text-muted">{children}</div>}
    <p className="mt-4">
      <a className="text-link underline" href="/">
        Back to the review canvas
      </a>
    </p>
  </main>
);

/** A round's input, its digests, and the round before's input once the server sent them. */
const roundNumber = Schema.decodeSync(RoundNumber);

const useRound = (id: ReviewId, round: Round | undefined) => {
  // Hooks run on every render, so a page without a round, or on its first, reads round 1 and ignores it.
  const current = useAtomValue(roundAtom({ id, round: round?.round ?? roundNumber(1) }));
  const before = useAtomValue(roundAtom({ id, round: roundNumber(round === undefined || round.round <= 1 ? 1 : round.round - 1) }));
  const view = AsyncResult.value(current).pipe(Option.getOrUndefined);
  const previous: ReviewInput | undefined =
    round === undefined || round.round <= 1 ? undefined : AsyncResult.value(before).pipe(Option.map((item: RoundView) => item.input), Option.getOrUndefined);
  const waitingForPrevious = round !== undefined && round.round > 1 && previous === undefined && !AsyncResult.isFailure(before);
  return { view, previous, ready: view !== undefined && !waitingForPrevious, failure: AsyncResult.isFailure(current) ? current.cause : undefined };
};

const Loaded = ({ id, snapshot }: { readonly id: ReviewId; readonly snapshot: ReviewSnapshot }) => {
  const round = snapshot.state.rounds.at(-1);
  const { view, previous, ready, failure } = useRound(id, round);
  const fresh = useMemo(
    () => (round === undefined || view === undefined || !ready ? undefined : pageModel(snapshot, round, view.input, view.digests, previous)),
    [snapshot, round, view, previous, ready],
  );
  // A new round's input arrives a moment after the snapshot that announces it. Until then the page keeps showing the
  // round it has, so the review stays mounted: the finish keeps the round it names, open files stay open, and the
  // new round is announced.
  const [last, setLast] = useState<PageModel | undefined>(undefined);
  if (fresh !== undefined && fresh !== last) setLast(fresh);
  const page = fresh ?? last;
  if (round === undefined) return <Waiting snapshot={snapshot} />;
  if (failure !== undefined) return <Message title="This review did not load">{failureMessage(failure)}</Message>;
  if (page === undefined) return <p className="p-8 text-muted">Loading round {round.round}…</p>;
  return <Review id={id} page={page} />;
};

export const ReviewPage = ({ id }: { readonly id: ReviewId }) => {
  const result = useAtomValue(reviewAtom(id));
  const snapshot = AsyncResult.value(result).pipe(Option.getOrUndefined);
  if (snapshot !== undefined) return <Loaded id={id} snapshot={snapshot} />;
  if (AsyncResult.isFailure(result)) {
    const refused = Cause.findErrorOption(result.cause).pipe(Option.filter((error) => error instanceof Refused));
    return Option.isSome(refused) && refused.value.kind === "not_found" ? (
      <Message title="No such review" />
    ) : (
      <Message title="This review did not load">{failureMessage(result.cause)}</Message>
    );
  }
  return <p className="p-8 text-muted">Loading the review…</p>;
};
