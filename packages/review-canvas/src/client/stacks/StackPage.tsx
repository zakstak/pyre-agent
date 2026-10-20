/**
 * A stack walkthrough: the agent's one narrative across a PR stack's ancestor path, a step at a time. A step of a
 * current layer shows as that layer's review shows a stop, inside the layer's review context, so comments, answers,
 * and Viewed marks go to the per-PR review. Next marks the step read and goes on, across PR boundaries. The server
 * keeps the position and the marks, so any tab resumes where the reviewer left off.
 */
import { RegistryContext, useAtom, useAtomValue } from "@effect/atom-react";
import { Cause, Exit, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { Check, CircleDot, TriangleAlert } from "lucide-react";
import { useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { flushSync } from "react-dom";
import { layerInput, neighbors, pullNumber } from "../../review/stack-steps.ts";
import type { StackId } from "../../schema/primitives.ts";
import { Refused } from "../../schema/rpc.ts";
import type {
  LayerState,
  StackAction,
  StackLayerView,
  StackSnapshot,
  StackStepView,
} from "../../schema/stack.ts";
import { failureText, NO_ANSWER } from "../rpc.ts";
import { ReviewContext, useSending } from "../review/act.ts";
import { reviewAtom, roundAtom } from "../review/data.ts";
import {
  Attention,
  General,
  StopProse,
  StopSection,
} from "../review/Sections.tsx";
import { generalDraftAtom, layoutAtom, NARROW_QUERY } from "../review/ui.ts";
import { type PageModel, pageModel } from "../review/view.ts";
import { Button, TOUCH_TARGET } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { useMedia } from "../ui/media.ts";
import { frame, Loading, Message, SkipLink, TopBar } from "../ui/page.tsx";
import { Inline, Prose, Time } from "../ui/text.tsx";
import { toast } from "../ui/toast.tsx";
import { stackActAtom, stackAtom } from "./data.ts";

type Go = (step: StackStepView, read: boolean) => Promise<void>;

/** Sends a move, one at a time; a refusal shows as a toast, and the next snapshot shows a move that went through. */
const useGo = (snapshot: StackSnapshot, current: StackStepView) => {
  const send = Option.getOrUndefined(
    AsyncResult.value(useAtomValue(stackActAtom(snapshot.id))),
  );
  const { busy, run } = useSending();
  const act = useCallback(
    async (action: StackAction) => {
      await run(async () => {
        if (send === undefined) return toast(NO_ANSWER, "danger");
        const exit = await send(action);
        if (Exit.isFailure(exit)) toast(failureText(exit.cause), "danger");
      });
    },
    [run, send],
  );
  // Only a step of a current layer can be read, at the version this page showed: a newer one is refused.
  const go: Go = (step, read) =>
    act({
      kind: "go",
      step: step.key,
      ...(read && current.version !== undefined
        ? { read: { step: current.key, version: current.version } }
        : {}),
    });
  const unread = () => act({ kind: "unread", step: current.key });
  return { go, unread, busy };
};

const READ_TEXT = {
  read: "read",
  changed: "changed since you read it",
  unread: "not read",
} as const;

const ReadMark = ({ step }: { readonly step: StackStepView }) => {
  const Icon =
    step.read === "read"
      ? Check
      : step.read === "changed"
        ? TriangleAlert
        : CircleDot;
  return (
    <Icon
      aria-hidden="true"
      className={cn(
        "mt-0.5 size-3.5 shrink-0",
        step.read === "read"
          ? "text-success"
          : step.read === "changed"
            ? "text-warning"
            : "text-muted",
      )}
    />
  );
};

/** A layer's review as the walkthrough found it, in a few words. */
const layerText = (state: LayerState): string => {
  switch (state.kind) {
    case "current":
      return `Review round ${state.round}`;
    case "stale":
      return `Moved to ${state.head_sha.slice(0, 7)} since this walkthrough`;
    case "missing":
      return state.review === undefined ? "No open review" : "No round yet";
  }
};

/** Every layer, base first, with its steps; each step goes there without marking the current one read. */
const Rail = ({
  snapshot,
  onGo,
  busy,
}: {
  readonly snapshot: StackSnapshot;
  readonly onGo: Go;
  readonly busy: boolean;
}) => (
  <nav
    aria-label="Stack walkthrough steps"
    className="self-start pt-6 lg:sticky lg:top-12"
  >
    <ol className="flex flex-col gap-4">
      {snapshot.layers.map((layer, index) => (
        <li key={layer.url} data-stack-layer={index}>
          <p className="text-small font-semibold wrap-anywhere">
            {pullNumber(layer.url)} {layer.title}
          </p>
          <p
            className={cn(
              "text-small",
              layer.state.kind === "current" ? "text-muted" : "text-warning",
            )}
          >
            {layerText(layer.state)}
          </p>
          <ol className="mt-1 flex flex-col">
            {snapshot.steps
              .filter((step) => step.layer === index)
              .map((step) => (
                <li key={step.key}>
                  <button
                    type="button"
                    disabled={busy}
                    data-step={step.key}
                    data-read={step.read}
                    aria-current={
                      step.key === snapshot.position ? "step" : undefined
                    }
                    onClick={() => void onGo(step, false)}
                    className={cn(
                      TOUCH_TARGET,
                      "flex w-full items-start gap-2 rounded-control px-2 py-1 text-left text-small hover:bg-subtle",
                      step.key === snapshot.position &&
                        "bg-subtle font-semibold",
                    )}
                  >
                    <ReadMark step={step} />
                    <span className="min-w-0 wrap-anywhere">
                      {step.title}
                      <span className="sr-only">, {READ_TEXT[step.read]}</span>
                    </span>
                  </button>
                </li>
              ))}
          </ol>
        </li>
      ))}
    </ol>
  </nav>
);

/** Which PR the step belongs to, with its review's state and links to it. */
const LayerBanner = ({
  layer,
  index,
  count,
}: {
  readonly layer: StackLayerView;
  readonly index: number;
  readonly count: number;
}) => {
  const review = layer.state.review;
  return (
    <div
      data-layer-banner
      className="mb-4 rounded-panel border border-separator bg-surface px-4 py-3"
    >
      <p className="text-small text-muted">
        Layer {index + 1} of {count}
        {index === 0 ? " · base" : ""}
        {index === count - 1 ? " · tip" : ""}
      </p>
      <p className="font-semibold wrap-anywhere">
        {pullNumber(layer.url)} {layer.title}
      </p>
      <p className="text-small text-muted">
        {review === undefined ? null : (
          <>
            <a
              href={`/reviews/${review}`}
              className="underline underline-offset-3"
            >
              Open this PR’s review
            </a>
            {" · "}
          </>
        )}
        <a href={layer.url} className="underline underline-offset-3">
          Open on host
        </a>
      </p>
      {layer.state.kind === "stale" ? (
        <p role="alert" className="mt-2 text-warning">
          The agent wrote these steps for {layer.head_sha.slice(0, 7)}; the
          review now shows {layer.state.head_sha.slice(0, 7)}. The excerpts are
          hidden, and earlier reads of this layer no longer count. Ask the agent
          to publish the walkthrough again.
        </p>
      ) : layer.state.kind === "missing" ? (
        <p role="alert" className="mt-2 text-warning">
          {layer.state.review === undefined
            ? "This PR has no open review, so its diff is not shown here. Ask the agent to register and publish one."
            : "This PR’s review has no round yet, so its diff is not shown here."}
        </p>
      ) : null}
    </div>
  );
};

/** A step whose layer is not current: the agent's prose, without excerpts that may no longer fit the code. */
const UnavailableStep = ({ step }: { readonly step: StackStepView }) => (
  <section data-stack-step={step.key}>
    <h2 className="text-heading font-semibold">{step.title}</h2>
    <StopProse stop={step} />
    <Attention stop={step} />
    {step.questions.length === 0 ? null : (
      <ul className="mt-3 list-disc pl-5 text-small">
        {step.questions.map((question) => (
          <li key={question}>
            <Inline text={question} />
          </li>
        ))}
      </ul>
    )}
  </section>
);

/** The step of a current layer, inside the layer's review: its files, notes, comments, and Viewed marks. */
const CurrentStep = ({
  snapshot,
  step,
  layer,
  state,
  onGo,
}: {
  readonly snapshot: StackSnapshot;
  readonly step: StackStepView;
  readonly layer: StackLayerView;
  readonly state: Extract<LayerState, { kind: "current" }>;
  readonly onGo: Go;
}) => {
  const registry = useContext(RegistryContext);
  const general = useRef<HTMLTextAreaElement>(null);
  const [layout] = useAtom(layoutAtom);
  const narrow = useMedia(NARROW_QUERY);
  const split = layout === "split" && !narrow;
  const review = useAtomValue(reviewAtom(state.review));
  const round = useAtomValue(
    roundAtom({ id: state.review, round: state.round }),
  );
  const reviewSnapshot = Option.getOrUndefined(AsyncResult.value(review));
  const view = Option.getOrUndefined(AsyncResult.value(round));
  const page = useMemo((): PageModel | undefined => {
    const published = reviewSnapshot?.state.rounds.find(
      (item) => item.round === state.round,
    );
    return reviewSnapshot === undefined ||
      view === undefined ||
      published === undefined
      ? undefined
      : pageModel(
          reviewSnapshot,
          published,
          layerInput(snapshot, layer.url, view.input),
          view.digests,
          undefined,
        );
  }, [reviewSnapshot, view, state.round, snapshot, layer.url]);
  const context = useMemo(
    () =>
      page === undefined
        ? undefined
        : { id: state.review, page, view: "guided" as const },
    [page, state.review],
  );
  const failure = AsyncResult.isFailure(review)
    ? review.cause
    : AsyncResult.isFailure(round)
      ? round.cause
      : undefined;
  if (context === undefined)
    return failure === undefined ? (
      <p role="status" className="text-muted">
        Loading {pullNumber(layer.url)}’s round {state.round}…
      </p>
    ) : (
      <p role="alert">{failureText(failure)}</p>
    );
  const stop = context.page.stops[step.stop ?? -1];
  if (stop === undefined) return <UnavailableStep step={step} />;
  /** An excerpt of a file an earlier step of this layer owns goes to that step. */
  const toOwner = (path: string) => {
    const owner = context.page.stops.find((item) =>
      item.owns.some((owned) => owned === path),
    );
    const key =
      owner === undefined
        ? undefined
        : owner.closing
          ? `L${step.layer}:other`
          : `L${step.layer}:S${owner.index}`;
    const target = snapshot.steps.find((item) => item.key === key);
    if (target !== undefined) void onGo(target, false);
  };
  const ask = (question: string) => {
    const area = general.current;
    if (area === null) return;
    const now = registry.get(generalDraftAtom(state.review));
    const next = now.startsWith(question)
      ? now
      : now === ""
        ? question
        : `${question}\n\n${now}`;
    flushSync(() => registry.set(generalDraftAtom(state.review), next));
    area.scrollIntoView({ block: "center" });
    area.focus();
    area.setSelectionRange(next.length, next.length);
  };
  return (
    <ReviewContext.Provider value={context}>
      <div data-stack-step={step.key}>
        <StopSection
          stop={stop}
          split={split}
          ruled={false}
          narration={`${pullNumber(layer.url)} · stop ${stop.index + 1} of ${context.page.stops.length}`}
          onFlash={toOwner}
          onAsk={ask}
        />
      </div>
      <General textarea={general} />
    </ReviewContext.Provider>
  );
};

/** Previous and next across PR boundaries. Next marks the step read; so does finishing on the last step. */
const StepNav = ({
  step,
  previous,
  next,
  onGo,
  onUnread,
  busy,
}: {
  readonly step: StackStepView;
  readonly previous: StackStepView | undefined;
  readonly next: StackStepView | undefined;
  readonly onGo: Go;
  readonly onUnread: () => Promise<void>;
  readonly busy: boolean;
}) => (
  <nav
    aria-label="Step navigation"
    className="mt-10 flex flex-wrap items-center gap-3 border-t border-separator pt-6"
  >
    {previous === undefined ? null : (
      <Button disabled={busy} onClick={() => void onGo(previous, false)}>
        Previous: {previous.title}
      </Button>
    )}
    {next !== undefined ? (
      <Button
        variant="primary"
        disabled={busy}
        onClick={() => void onGo(next, true)}
      >
        Next: {next.title}
      </Button>
    ) : step.version !== undefined && step.read !== "read" ? (
      <Button
        variant="primary"
        disabled={busy}
        onClick={() => void onGo(step, true)}
      >
        Mark read
      </Button>
    ) : (
      <span className="text-small text-muted">End of the walkthrough.</span>
    )}
    {step.read === "unread" ? null : (
      <Button
        variant="quiet"
        size="sm"
        disabled={busy}
        onClick={() => void onUnread()}
      >
        Mark unread
      </Button>
    )}
  </nav>
);

const Walkthrough = ({ snapshot }: { readonly snapshot: StackSnapshot }) => {
  const { index, previous, next } = neighbors(
    snapshot.steps,
    snapshot.position,
  );
  const step = snapshot.steps[index] ?? snapshot.steps[0];
  if (step === undefined)
    throw new Error("A stack walkthrough always has a step.");
  const layer = snapshot.layers[step.layer];
  if (layer === undefined)
    throw new Error("A step names a layer of its walkthrough.");
  const { go, unread, busy } = useGo(snapshot, step);
  const read = snapshot.steps.filter((item) => item.read === "read").length;
  const position = useRef<HTMLParagraphElement>(null);
  const shown = useRef(snapshot.position);
  useEffect(() => {
    document.title = `${snapshot.walkthrough.title} · Stack walkthrough · Review canvas`;
  }, [snapshot.walkthrough.title]);
  // A move starts the new step at its top, with focus on where the reviewer is; loading or reloading does not move focus.
  useEffect(() => {
    if (shown.current === snapshot.position) return;
    shown.current = snapshot.position;
    window.scrollTo({ top: 0 });
    position.current?.focus();
  }, [snapshot.position]);
  return (
    <>
      <SkipLink />
      <TopBar width="review" place="Stack walkthrough" />
      <div
        className={cn(
          frame({ width: "review" }),
          "grid grid-cols-1 gap-x-8 lg:grid-cols-[17rem_minmax(0,1fr)]",
        )}
      >
        <header className="col-span-full pt-6">
          <h1 className="text-title font-semibold tracking-tight">
            {snapshot.walkthrough.title}
          </h1>
          <p data-stack-progress className="mt-1.5 text-small text-muted">
            {snapshot.layers.length} PRs, base first · {read} of{" "}
            {snapshot.steps.length} steps read · published{" "}
            <Time at={snapshot.created_at} />
          </p>
          {snapshot.closed_at === undefined ? null : (
            <p role="alert" className="mt-2">
              The agent replaced this walkthrough.{" "}
              {snapshot.replaced_by === undefined ? null : (
                <a
                  href={`/stacks/${snapshot.replaced_by}`}
                  className="underline underline-offset-3"
                >
                  Open the newer one
                </a>
              )}
            </p>
          )}
          {snapshot.historical ? (
            <p
              data-historical
              className="mt-2 max-w-reading text-small text-muted"
            >
              Historical stack: each layer shows its final retained head,
              reconstructed from base-change history. Earlier force-pushed
              revisions are not represented, and merge-sync or
              conflict-resolution changes may remain in a layer.
            </p>
          ) : null}
          {snapshot.walkthrough.summary === undefined ? null : (
            <div className="mt-3 max-w-reading">
              <Prose text={snapshot.walkthrough.summary} />
            </div>
          )}
          {snapshot.excluded.length === 0 ? null : (
            <p
              data-excluded
              className="mt-2 text-small text-muted wrap-anywhere"
            >
              Not on this path:{" "}
              {snapshot.excluded.map((pull, at) => (
                <span key={pull.url}>
                  {at === 0 ? "" : ", "}
                  <a href={pull.url} className="underline underline-offset-3">
                    {pullNumber(pull.url)} {pull.title}
                  </a>
                </span>
              ))}
              . Sibling branches and PRs that build on the tip are left out of
              this walkthrough.
            </p>
          )}
        </header>
        <Rail snapshot={snapshot} onGo={go} busy={busy} />
        <main id="main" tabIndex={-1} className="min-w-0 pt-6 outline-none">
          <p
            ref={position}
            tabIndex={-1}
            data-stack-position
            className="mb-2 text-small font-semibold outline-none"
          >
            Step {index + 1} of {snapshot.steps.length}
            {step.read === "changed"
              ? " · changed since you read it"
              : step.read === "read"
                ? " · read"
                : ""}
          </p>
          <LayerBanner
            layer={layer}
            index={step.layer}
            count={snapshot.layers.length}
          />
          {layer.state.kind === "current" ? (
            <CurrentStep
              key={step.key}
              snapshot={snapshot}
              step={step}
              layer={layer}
              state={layer.state}
              onGo={go}
            />
          ) : (
            <UnavailableStep step={step} />
          )}
          <StepNav
            step={step}
            previous={previous}
            next={next}
            onGo={go}
            onUnread={unread}
            busy={busy}
          />
        </main>
      </div>
    </>
  );
};

export const StackPage = ({ id }: { readonly id: StackId }) => {
  const result = useAtomValue(stackAtom(id));
  const snapshot = Option.getOrUndefined(AsyncResult.value(result));
  if (snapshot !== undefined) return <Walkthrough snapshot={snapshot} />;
  if (AsyncResult.isFailure(result)) {
    const refused = Cause.findErrorOption(result.cause).pipe(
      Option.filter((error) => error instanceof Refused),
    );
    return Option.isSome(refused) && refused.value.kind === "not_found" ? (
      <Message title="No such stack walkthrough" />
    ) : (
      <Message title="This walkthrough did not load">
        {failureText(result.cause)}
      </Message>
    );
  }
  return <Loading width="review">Loading the stack walkthrough…</Loading>;
};
