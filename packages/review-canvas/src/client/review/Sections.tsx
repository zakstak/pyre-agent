/** The sections of the review page's one scroll: the stops with their files, then the whole change and the finish. */
import { useAtom } from "@effect/atom-react";
import { ArrowUp, Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Verdict } from "../../schema/feedback.ts";
import type { RoundNumber } from "../../schema/primitives.ts";
import { parseRows } from "../../review/patch.ts";
import type { StopView } from "../../review/tour.ts";
import { count, lineRange, VERDICT_DONE, VERDICT_TEXT } from "../names.ts";
import { Button, TOUCH_TARGET } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Stat } from "../ui/stat.tsx";
import { Inline, Joined, Prose, Time } from "../ui/text.tsx";
import { Textarea } from "../ui/textarea.tsx";
import { toast } from "../ui/toast.tsx";
import { useAct, usePage, useSending } from "./act.ts";
import { FileBlock } from "./FileBlock.tsx";
import { Narration } from "./Header.tsx";
import { ACTIONS_CLASS, Orphan, submitOnModEnter, ThreadView } from "./Thread.tsx";
import { finishDraftAtom, generalDraftAtom } from "./ui.ts";
import { finishState } from "./view.ts";

const ATTENTION_LEAD = {
  tradeoff: "Tradeoff",
  contract: "Contract",
  product: "Product call",
  risk: "Risk",
  accessibility: "Accessibility",
} as const;

/** For an excerpt of a file an earlier stop owns: one line that points at those rows instead of a second diff. */
const Also = ({ stop, onFlash }: { readonly stop: StopView; readonly onFlash: (path: string, index: number, start: number, end: number) => void }) => {
  const { page } = usePage();
  const elsewhere = stop.excerpts.filter((excerpt) => !stop.owns.includes(excerpt.path));
  if (elsewhere.length === 0) return null;
  const links = elsewhere.flatMap((excerpt) => {
    const model = page.files.get(excerpt.path);
    if (model === undefined) return [];
    const lines = parseRows(model.file.patch ?? "")
      .slice(excerpt.start_row, excerpt.end_row + 1)
      .map((row) => row[excerpt.side])
      .filter((line) => line !== undefined);
    const first = lines[0];
    const last = lines.at(-1);
    return [
      <a
        href={`#f${model.index}-r${excerpt.start_row}`}
        onClick={(event) => {
          event.preventDefault();
          onFlash(excerpt.path, model.index, excerpt.start_row, excerpt.end_row);
        }}
        className="text-link underline underline-offset-3"
      >
        <code>{excerpt.path}</code>
        {first === undefined || last === undefined ? "" : ` ${lineRange(first, last, "line")}`}{" "}
        <ArrowUp aria-hidden="true" className="inline size-3 align-[-0.0625em]" />
      </a>,
    ];
  });
  return (
    <p data-also className="mt-3 text-small">
      Also in this stop: <Joined items={links} />
    </p>
  );
};

/** A stop's summary, as the agent wrote it. */
export const StopProse = ({ stop }: { readonly stop: StopView }) =>
  stop.summary.trim() === "" ? null : (
    <div className="mt-2 max-w-reading">
      <Prose text={stop.summary} />
    </div>
  );

/** What the agent asks the reviewer to weigh at a stop, led by its kind. */
export const Attention = ({ stop }: { readonly stop: StopView }) =>
  stop.attention === null ? null : (
    <p data-attention className="mt-3 max-w-reading border-l-2 border-warning pl-3.5">
      <strong className="text-warning">{ATTENTION_LEAD[stop.attention.kind]}.</strong> <Inline text={stop.attention.note} />
    </p>
  );

/** The questions a stop suggests, each of which starts the comment on the whole change. A closed review asks none. */
export const Questions = ({ stop, onAsk }: { readonly stop: StopView; readonly onAsk: (question: string) => void }) => {
  const { page } = usePage();
  return stop.questions.length === 0 || !page.writable ? null : (
    <div role="group" aria-label="Questions to ask" className="mt-3 flex flex-wrap gap-2">
      {stop.questions.map((question) => (
        <button
          key={question}
          type="button"
          data-question={question}
          onClick={() => onAsk(question)}
          className={cn(TOUCH_TARGET, "inline-flex min-h-7 items-center gap-2 rounded-control border border-line bg-raised px-2.5 py-0.5 text-left text-small hover:bg-subtle")}
        >
          <span aria-hidden="true" className="font-bold text-accent">
            ?
          </span>
          <Inline text={question} />
        </button>
      ))}
    </div>
  );
};

/** A rule over a section of the page's one scroll, after the one before it. */
const RULED = "mt-10 border-t border-separator pt-8";

export const StopSection = ({
  stop,
  split,
  ruled,
  onFlash,
  onAsk,
}: {
  readonly stop: StopView;
  readonly split: boolean;
  /** A rule parts the stop from what comes before it: every stop but a first with no round summary over it. */
  readonly ruled: boolean;
  readonly onFlash: (path: string, index: number, start: number, end: number) => void;
  readonly onAsk: (question: string) => void;
}) => {
  const { page } = usePage();
  const owned = stop.owns.flatMap((path) => {
    const model = page.files.get(path);
    return model === undefined ? [] : [model];
  });
  const viewed = owned.filter((model) => model.approved).length;
  return (
    <section
      id={`stop-${stop.index + 1}`}
      data-stop={stop.index}
      className={cn("scroll-mt-(--sticky-top)", ruled ? RULED : "mt-0", ruled && stop.index === 0 && "mt-8")}
    >
      <Narration className="mb-1">
        Walkthrough · stop {stop.index + 1} of {page.stops.length}
      </Narration>
      <div data-stop-head className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={`stop-${stop.index + 1}-title`} tabIndex={-1} className="scroll-mt-(--sticky-top) text-heading font-semibold">
          <span className="mr-1 font-mono text-reading font-normal text-muted">{stop.index + 1}</span>{" "}
          <span>{stop.title}</span>
        </h2>
        <Stat icon={Check} title={`${viewed} of ${count(owned.length, "file")} viewed`}>
          {viewed}/{owned.length}
        </Stat>
      </div>
      <StopProse stop={stop} />
      <Attention stop={stop} />
      <Also stop={stop} onFlash={onFlash} />
      {owned.map((model) => (
        <FileBlock key={model.file.path} model={model} split={split} />
      ))}
      <Questions stop={stop} onAsk={onAsk} />
    </section>
  );
};

const END_SECTION = cn(RULED, "scroll-mt-(--sticky-top)");

/** The finish as a card, open or finished, so the page ends on something to act on. It follows the whole change. */
const FINISH_CARD = "mt-6 scroll-mt-(--sticky-top) rounded-panel bg-surface p-5";

/**
 * Inline comments on files that left the round, such as a reverted or renamed file. No file block shows them, so
 * they get their own section; otherwise their answers could never be read or accepted.
 */
export const Departed = () => {
  const { page } = usePage();
  if (page.departed.length === 0) return null;
  return (
    <section id="departed" data-end-section className={END_SECTION}>
      <h2 className="text-heading font-semibold">Files that left the round</h2>
      <div className="mt-3 rounded-panel bg-surface">
        {page.departed.map((comment) => (
          <Orphan key={comment.id} comment={comment} withPath />
        ))}
      </div>
    </section>
  );
};

export const General = ({ textarea }: { readonly textarea: React.RefObject<HTMLTextAreaElement | null> }) => {
  const { page } = usePage();
  const act = useAct();
  const [body, setBody] = useAtom(generalDraftAtom);
  const { busy, run } = useSending();
  // A closed review has nothing to add: the section shows only what was said.
  if (!page.writable && page.general.length === 0) return null;
  const send = async (question: boolean) => {
    const text = body.trim();
    if (text === "") return textarea.current?.focus();
    const outcome = await run(() => act({ kind: "general_comment", body: text, ...(question ? { question: true } : {}) }));
    if (outcome?.ok === true) setBody((now) => (now === body ? "" : now));
  };
  return (
    <section id="general" data-end-section className={END_SECTION}>
      <h2 className="text-heading font-semibold">On the whole change</h2>
      {page.general.length === 0 ? null : (
        <div className="mt-3 flex flex-col gap-3">
          {page.general.map((comment) => (
            <div key={comment.id} className="rounded-panel bg-surface px-4 py-3">
              <ThreadView comment={comment} />
            </div>
          ))}
        </div>
      )}
      {!page.writable ? null : (
        <form
          className="mt-3"
          onSubmit={(event) => {
            event.preventDefault();
            void send(false);
          }}
        >
          <label className="sr-only" htmlFor="general-body">
            Comment on the whole change
          </label>
          <Textarea
            ref={textarea}
            id="general-body"
            rows={2}
            readOnly={busy}
            value={body}
            placeholder="A question, a concern, or a direction for the agents"
            onChange={(event) => setBody(event.currentTarget.value)}
            onKeyDown={submitOnModEnter}
          />
          <div className={ACTIONS_CLASS}>
            <Button type="submit" size="sm" variant="primary" disabled={busy}>
              Comment
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void send(true)}>
              Ask now
            </Button>
            {page.finished ? null : (
              <span className="text-small text-muted">A comment waits for Finish review; Ask now sends a question at once.</span>
            )}
          </div>
        </form>
      )}
    </section>
  );
};

const VERDICTS: ReadonlyArray<{ readonly value: Verdict; readonly label: string }> = [
  { value: "approve", label: "Approve" },
  { value: "request_changes", label: "Request changes" },
  { value: "comment", label: "Comment only" },
];

/**
 * The finish. A verdict names the round the reviewer read: while they are in the section, a new round leaves it on
 * the round it showed, and it catches up once focus leaves it or the server refuses the old round. The verdict and
 * summary carry over.
 */
export const Finish = () => {
  const { page } = usePage();
  const act = useAct();
  const [draft, setDraft] = useAtom(finishDraftAtom);
  const { busy, run } = useSending();
  const section = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [engaged, setEngaged] = useState(false);
  const [shownRound, setShownRound] = useState<RoundNumber>(page.round.round);
  const behind = shownRound !== page.round.round;
  // A new round is announced here, where it is known whether the finish keeps the round the reviewer read: it does
  // while they are in the section or have written a summary.
  const announced = useRef(page.round.round);
  useEffect(() => {
    if (announced.current === page.round.round) return;
    announced.current = page.round.round;
    toast(
      engaged || draft.body !== ""
        ? `Round ${page.round.round} was published. Your finish still names round ${shownRound}.`
        : `Round ${page.round.round} was published.`,
    );
  }, [page.round.round]);
  // A new round while the reviewer is not choosing a verdict or writing a summary: the section shows it at once.
  useEffect(() => {
    if (!engaged && draft.body === "" && behind) setShownRound(page.round.round);
  }, [engaged, draft.body, behind, page.round.round]);
  const catchUp = () => {
    setShownRound(page.round.round);
    if (section.current?.contains(document.activeElement) === true)
      requestAnimationFrame(() =>
        (section.current?.querySelector<HTMLElement>("input[name='verdict']:checked") ?? heading.current)?.focus(),
      );
  };
  // A closed review cannot be finished, and the strip already says it is closed.
  if (!page.writable) return null;
  const submission = page.snapshot.state.submissions.findLast((item) => item.round === page.round.round);
  if (submission !== undefined && !behind)
    return (
      <section id="finish" ref={section} data-end-section data-round={page.round.round} className={FINISH_CARD}>
        <h2 id="finish-title" ref={heading} tabIndex={-1} className="text-heading font-semibold">
          Round {page.round.round} finished · {VERDICT_TEXT[submission.verdict]} · <Time at={submission.submitted_at} />
        </h2>
        <p data-submission className="mt-2">
          You {VERDICT_DONE[submission.verdict]} at <Time at={submission.submitted_at} />
          {submission.body.trim() === "" ? "." : `: ${submission.body}`}
        </p>
      </section>
    );
  return (
    <section
      id="finish"
      ref={section}
      data-end-section
      data-round={shownRound}
      className={FINISH_CARD}
      onFocus={() => setEngaged(true)}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && !event.currentTarget.contains(next)) {
          setEngaged(false);
          if (behind) catchUp();
        }
      }}
    >
      <h2 id="finish-title" ref={heading} tabIndex={-1} className="text-heading font-semibold">
        Finish round {shownRound}
      </h2>
      <p className="mt-1 text-small text-muted">{finishState(page.progress)}</p>
      <form
        data-round={shownRound}
        className="mt-4"
        onSubmit={async (event) => {
          event.preventDefault();
          const outcome = await run(() =>
            act({ kind: "submit", round: shownRound, verdict: draft.verdict, body: draft.body }),
          );
          if (outcome === undefined) return;
          if (!outcome.ok) return catchUp();
          toast("Review finished. The agents have the turn.");
          setDraft({ verdict: "comment", body: "" });
          requestAnimationFrame(() => document.getElementById("finish-title")?.focus({ preventScroll: true }));
        }}
      >
        <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0">
          <legend className="sr-only">Verdict</legend>
          {VERDICTS.map((verdict) => (
            <label
              key={verdict.value}
              className={cn(
                "inline-flex min-h-11 items-center gap-2 rounded-control border px-3 font-semibold",
                draft.verdict === verdict.value ? "border-accent bg-selected" : "border-line bg-raised hover:bg-subtle",
              )}
            >
              <input
                type="radio"
                name="verdict"
                value={verdict.value}
                checked={draft.verdict === verdict.value}
                disabled={busy}
                onChange={() => setDraft((now) => ({ ...now, verdict: verdict.value }))}
                className="size-4 accent-accent"
              />
              {verdict.label}
            </label>
          ))}
        </fieldset>
        <label className="sr-only" htmlFor="finish-body">
          Summary
        </label>
        <Textarea
          id="finish-body"
          rows={3}
          readOnly={busy}
          value={draft.body}
          placeholder="What the agents should do next"
          onChange={(event) => {
            const body = event.currentTarget.value;
            setDraft((now) => ({ ...now, body }));
          }}
          onKeyDown={submitOnModEnter}
          className="mt-3"
        />
        <div className={ACTIONS_CLASS}>
          <Button type="submit" variant="primary" disabled={busy}>
            Finish review
          </Button>
        </div>
      </form>
    </section>
  );
};
