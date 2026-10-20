/**
 * The review page: one scroll in the order the agent's stops tell the story. Each stop is a section with the agent's
 * prose and the files it owns as whole diffs, the notes in the code; the conversation sits under the rows it is about;
 * the whole change and the finish come last. A strip under the title always names the one thing to do next.
 *
 * The source view parts the two: the walkthrough is a guide beside the diff, and the diff is every file in path order.
 */
import { ReviewStack } from "../home/PullRequests.tsx";
import { RegistryContext, useAtom, useAtomValue } from "@effect/atom-react";
import { Cause, Option, Schema } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { ReviewInput } from "../../schema/input.ts";
import {
  type RepoPath,
  type ReviewId,
  RoundNumber,
} from "../../schema/primitives.ts";
import {
  Refused,
  type ReviewSnapshot,
  type RoundView,
} from "../../schema/rpc.ts";
import { fileElementId } from "../../review/next.ts";
import type { Round } from "../../review/queries.ts";
import { count, threadName } from "../names.ts";
import { type CallError, failureText } from "../rpc.ts";
import { useMedia } from "../ui/media.ts";
import { cn } from "../ui/cn.ts";
import { frame, Loading, Message, SkipLink } from "../ui/page.tsx";
import { TargetText } from "../ui/target.tsx";
import { Prose, Time } from "../ui/text.tsx";
import { toast } from "../ui/toast.tsx";
import { ReviewContext, useImport } from "./act.ts";
import { Contents } from "./Contents.tsx";
import { reviewAtom, type RoundKey, roundAtom } from "./data.ts";
import { Guide } from "./Guide.tsx";
import { Narration, ReviewBar, Title, ViewControl, Who } from "./Header.tsx";
import { useHash, useKeys, useNavigate, useScrollSpy } from "./navigate.ts";
import { hashOf } from "./places.ts";
import { FileBlock } from "./FileBlock.tsx";
import { Finish } from "./Finish.tsx";
import { Departed, General, StopSection } from "./Sections.tsx";
import { NextStrip, useStickyBars } from "./Strip.tsx";
import {
  draftsAtom,
  foldsAtom,
  generalDraftAtom,
  layoutAtom,
  NARROW_QUERY,
  stashAtom,
  type View,
  viewAtom,
} from "./ui.ts";
import { type PageModel, pageModel, pathOrder } from "./view.ts";

/** A feedback file the reviewer chose, imported through the server's checks, with what it added and left out. */
const ImportFeedback = () => {
  const runImport = useImport();
  return (
    <label className="rounded-sm font-normal underline underline-offset-3 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus">
      Import feedback
      <input
        type="file"
        accept="application/json,.json"
        className="sr-only"
        onChange={async (event) => {
          const input = event.currentTarget;
          const file = input.files?.[0];
          input.value = "";
          if (file === undefined) return;
          const imported = await runImport(await file.text());
          if (!imported.ok)
            return toast(`Not imported: ${imported.message}`, "danger");
          const report = imported.value;
          const added = `Imported ${count(report.comments, "comment")}, ${count(report.replies, "reply", "replies")}, and ${count(report.approvals, "approval")}.`;
          const already =
            report.already === 0 ? "" : ` ${report.already} already here.`;
          toast(
            `${added}${already}${report.skipped.length === 0 ? "" : ` ${report.skipped.join(" ")}`}`,
          );
        }}
      />
    </label>
  );
};

/**
 * The footer: for a review with a round, its feedback out and in, and the review's ID. Import needs the page's
 * context. It sits in the frame but outside its grid, so the contents, which stick within the grid, end where the
 * review ends.
 */
const Footer = ({
  id,
  round,
  writable,
}: {
  readonly id: ReviewId;
  readonly round: boolean;
  readonly writable: boolean;
}) => (
  <footer
    className={cn(
      frame({ width: "review" }),
      "mt-12 flex flex-wrap items-center gap-x-6 gap-y-2 pb-16 text-small text-muted",
    )}
  >
    {round ? (
      <a
        href={`/reviews/${id}/feedback.json`}
        download
        className="underline underline-offset-3"
      >
        Export feedback
      </a>
    ) : null}
    {round && writable ? <ImportFeedback /> : null}
    <code className="text-technical">{id}</code>
  </footer>
);

/**
 * The page under the top bar: the contents beside the review on a wide page, everything else across both. The source
 * view's guide is wider than the contents: it holds prose and code.
 */
const Frame = ({
  view = "guided",
  children,
}: {
  readonly view?: View;
  readonly children: React.ReactNode;
}) => (
  <div
    className={cn(
      frame({ width: "review" }),
      "grid grid-cols-1 gap-x-8",
      view === "source"
        ? "lg:grid-cols-[24rem_minmax(0,1fr)]"
        : "lg:grid-cols-[15rem_minmax(0,1fr)]",
    )}
  >
    {children}
  </div>
);

/** A review no thread has published a round to yet: the title, one sentence, and the footer. */
const Waiting = ({ snapshot }: { readonly snapshot: ReviewSnapshot }) => {
  const names = snapshot.threads.map((item) => threadName(item.label));
  const who =
    names.length === 0
      ? "the agents"
      : names.length === 1
        ? names[0]
        : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  const first = snapshot.threads[0];
  useEffect(() => {
    document.title = `Waiting for the first round · ${snapshot.state.target.title} · Review canvas`;
  }, [snapshot.state.target.title]);
  return (
    <>
      <SkipLink />
      <ReviewBar
        target={snapshot.state.target}
        updated={snapshot.state.created_at}
      />
      <Frame>
        <header className="col-span-full pt-6">
          <h1 className="text-title font-semibold tracking-tight">
            {snapshot.state.target.title}
          </h1>
          <p className="mt-1.5 flex flex-wrap items-baseline gap-x-3.5 text-small text-muted">
            {first === undefined ? null : (
              <Who thread={first} id={first.id}>
                started this review at <Time at={snapshot.state.created_at} />
              </Who>
            )}
            <TargetText target={snapshot.state.target} />
          </p>
        </header>
        <main id="main" tabIndex={-1} className="col-span-full pt-6">
          <ReviewStack target={snapshot.state.target} />
          <p className="max-w-reading">
            Waiting for {who}’s first round. This page updates itself.
          </p>
        </main>
      </Frame>
      <Footer id={snapshot.state.id} round={false} writable={false} />
    </>
  );
};

/**
 * What a new round changes on the page. It keeps the files that were open; the finish section announces it. The open
 * files come from the folds as they were at the last render of the round before. A draft whose code changed cannot
 * stay on its rows: its text goes to the stash, which fills the next comment the reviewer opens.
 */
const useRoundChange = (key: RoundKey, page: PageModel) => {
  const registry = useContext(RegistryContext);
  const before = useRef<
    | { readonly round: RoundNumber; readonly open: ReadonlySet<RepoPath> }
    | undefined
  >(undefined);
  // Every render, so the open files are the ones of the last render before the round changed.
  useEffect(() => {
    const folds = registry.get(foldsAtom(key));
    const open = new Set(
      [...page.files.values()]
        .filter(
          (model) =>
            (folds[model.file.path] ?? (model.folded ? "closed" : "open")) ===
            "open",
        )
        .map((model) => model.file.path),
    );
    const was = before.current;
    before.current = { round: page.round.round, open };
    if (was === undefined || was.round === page.round.round) return;
    const carried = { ...folds };
    for (const path of was.open)
      if (
        !open.has(path) &&
        page.files.has(path) &&
        carried[path] === undefined
      )
        carried[path] = "open";
    registry.set(foldsAtom(key), carried);
  });
  useEffect(() => {
    const drafts = registry.get(draftsAtom(key.id));
    const lost = drafts.filter(
      (draft) =>
        !draft.submitting &&
        page.files.get(draft.path)?.digest !== draft.digest,
    );
    if (lost.length === 0) return;
    registry.set(
      draftsAtom(key.id),
      drafts.filter((draft) => !lost.includes(draft)),
    );
    const text = lost
      .map((draft) => draft.body)
      .find((body) => body.trim() !== "");
    if (text !== undefined) {
      registry.set(stashAtom(key.id), text);
      toast(
        "The code under your comment changed in a new round. Your text is kept: select lines to comment on, and it fills the new comment.",
        "danger",
      );
    }
  }, [key.id, page.files, registry]);
};

const Review = ({
  id,
  page,
}: {
  readonly id: ReviewId;
  readonly page: PageModel;
}) => {
  const key = useMemo(
    () => ({ id, round: page.round.round }),
    [id, page.round.round],
  );
  const registry = useContext(RegistryContext);
  const general = useRef<HTMLTextAreaElement>(null);
  const [layout] = useAtom(layoutAtom);
  const [chosen] = useAtom(viewAtom);
  const narrow = useMedia(NARROW_QUERY);
  const split = layout === "split" && !narrow;
  const view: View = narrow ? "guided" : chosen;
  const navigate = useNavigate(key, page, view);
  useStickyBars();
  const context = useMemo(() => ({ id, page, view }), [id, page, view]);

  useEffect(() => {
    document.title = `${page.input.target.title} · Review canvas`;
  }, [page.input.target.title]);
  useHash(navigate);
  useScrollSpy(navigate);
  useKeys(id, navigate);
  useRoundChange(key, page);

  /** Puts a stop's question at the start of the comment on the whole change, and the caret after it. */
  const ask = (question: string) => {
    const area = general.current;
    if (area === null) return;
    const now = registry.get(generalDraftAtom(id));
    const next = now.startsWith(question)
      ? now
      : now === ""
        ? question
        : `${question}\n\n${now}`;
    // Drawn at once, so the caret goes after the text the box now holds.
    flushSync(() => registry.set(generalDraftAtom(id), next));
    area.scrollIntoView({ block: "center" });
    area.focus();
    area.setSelectionRange(next.length, next.length);
  };

  /** Goes to a file from the contents or the guide, and names it in the hash. */
  const showFile = (path: RepoPath) => {
    history.replaceState(null, "", hashOf(fileElementId(path)));
    void navigate.showFile(path);
  };

  return (
    <ReviewContext.Provider value={context}>
      <SkipLink />
      <ReviewBar target={page.snapshot.state.target} updated={page.updated}>
        <ViewControl />
      </ReviewBar>
      <Frame view={view}>
        <Title id={id} />
        <div className="col-span-full">
          <ReviewStack target={page.snapshot.state.target} />
        </div>
        <NextStrip
          onGo={() => void navigate.goNext()}
          onStep={(step) => void navigate.goStep(step)}
          onFinish={() => void navigate.goFinish()}
        />
        {view === "source" ? (
          <Guide
            onFile={showFile}
            onExcerpt={(target) => void navigate.showExcerpt(target)}
            onAsk={ask}
            steering={navigate.steering}
          />
        ) : (
          <Contents
            onStop={(index) => void navigate.showStop(index)}
            onFile={showFile}
          />
        )}
        <main id="main" tabIndex={-1} className="min-w-0 pt-6 outline-none">
          {view === "source" ? (
            pathOrder(page.files.keys()).map((path) => {
              const model = page.files.get(path);
              return model === undefined ? null : (
                <FileBlock key={path} model={model} split={split} />
              );
            })
          ) : (
            <>
              {page.input.summary === undefined ? null : (
                <div className="max-w-reading">
                  <Narration className="mb-1.5">
                    · Round {page.round.round} · published{" "}
                    <Time at={page.round.published_at} />
                  </Narration>
                  <Prose text={page.input.summary} />
                </div>
              )}
              {page.stops.map((stop) => (
                <StopSection
                  key={stop.index}
                  stop={stop}
                  split={split}
                  ruled={stop.index > 0 || page.input.summary !== undefined}
                  onFlash={(path, index, start, end) =>
                    void navigate.flash(path, index, start, end)
                  }
                  onAsk={ask}
                />
              ))}
            </>
          )}
          <Departed />
          <General textarea={general} />
          <Finish key={page.writable ? "open" : "closed"} />
        </main>
      </Frame>
      <Footer id={id} round writable={page.writable} />
    </ReviewContext.Provider>
  );
};

const roundNumber = Schema.decodeSync(RoundNumber);

/** No round to read: what a review without one, or a first round's round before, stands for. */
const noRound = Atom.make<AsyncResult.AsyncResult<RoundView, CallError>>(
  AsyncResult.initial(),
);

/**
 * A round's input and digests, and the input of the round before, once the server sent them. A round that does not
 * exist is never asked for: the server would refuse it, and a refusal is kept until the next reconnect.
 */
const useRound = (id: ReviewId, round: Round | undefined) => {
  const current = useAtomValue(
    round === undefined ? noRound : roundAtom({ id, round: round.round }),
  );
  const before = useAtomValue(
    round === undefined || round.round <= 1
      ? noRound
      : roundAtom({ id, round: roundNumber(round.round - 1) }),
  );
  const view = AsyncResult.value(current).pipe(Option.getOrUndefined);
  const previous: ReviewInput | undefined = AsyncResult.value(before).pipe(
    Option.map((item) => item.input),
    Option.getOrUndefined,
  );
  const waitingForPrevious =
    round !== undefined &&
    round.round > 1 &&
    previous === undefined &&
    !AsyncResult.isFailure(before);
  return {
    view,
    previous,
    ready: view !== undefined && !waitingForPrevious,
    failure: AsyncResult.isFailure(current) ? current.cause : undefined,
  };
};

const Loaded = ({
  id,
  snapshot,
}: {
  readonly id: ReviewId;
  readonly snapshot: ReviewSnapshot;
}) => {
  const round = snapshot.state.rounds.at(-1);
  const { view, previous, ready, failure } = useRound(id, round);
  const fresh = useMemo(
    () =>
      round === undefined || view === undefined || !ready
        ? undefined
        : pageModel(snapshot, round, view.input, view.digests, previous),
    [snapshot, round, view, previous, ready],
  );
  // A new round's input arrives a moment after the snapshot that announces it. Until then the page keeps showing the
  // round it has, so the review stays mounted: the finish keeps the round it names, open files stay open, and the
  // new round is announced.
  const [last, setLast] = useState<PageModel | undefined>(undefined);
  if (fresh !== undefined && fresh !== last) setLast(fresh);
  const page = fresh ?? last;
  if (round === undefined) return <Waiting snapshot={snapshot} />;
  // A page already showing keeps showing while the next round fails to load; the reconnect reads it again.
  if (page === undefined && failure !== undefined)
    return (
      <Message title="This review did not load">{failureText(failure)}</Message>
    );
  if (page === undefined)
    return <Loading width="review">{`Loading round ${round.round}…`}</Loading>;
  return <Review id={id} page={page} />;
};

export const ReviewPage = ({ id }: { readonly id: ReviewId }) => {
  const result = useAtomValue(reviewAtom(id));
  const snapshot = AsyncResult.value(result).pipe(Option.getOrUndefined);
  if (snapshot !== undefined) return <Loaded id={id} snapshot={snapshot} />;
  if (AsyncResult.isFailure(result)) {
    const refused = Cause.findErrorOption(result.cause).pipe(
      Option.filter((error) => error instanceof Refused),
    );
    return Option.isSome(refused) && refused.value.kind === "not_found" ? (
      <Message title="No such review" />
    ) : (
      <Message title="This review did not load">
        {failureText(result.cause)}
      </Message>
    );
  }
  return <Loading width="review">Loading the review…</Loading>;
};
