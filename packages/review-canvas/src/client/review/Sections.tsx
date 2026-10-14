/** The sections of the review page's one scroll: the stops with their files, then the whole change and the finish. */
import { useAtom, useAtomSet } from "@effect/atom-react";
import { useEffect, useRef, useState } from "react";
import type { Verdict } from "../../schema/feedback.ts";
import type { RoundNumber } from "../../schema/primitives.ts";
import { parseRows } from "../../review/patch.ts";
import type { StopView } from "../../review/tour.ts";
import { count } from "../names.ts";
import { Button, TOUCH_TARGET } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Inline, Prose, Time } from "../ui/text.tsx";
import { toast } from "../ui/toast.tsx";
import { useAct, usePage } from "./act.ts";
import { FileBlock } from "./FileBlock.tsx";
import { ACTIONS_CLASS, Orphan, submitOnModEnter, ThreadView } from "./Thread.tsx";
import { finishDraftAtom, generalDraftAtom, reattachAtom } from "./ui.ts";
import { finishState } from "./view.ts";
import { VERDICT_DONE, VERDICT_TEXT } from "../names.ts";

const ATTENTION_LEAD = {
  tradeoff: "Tradeoff",
  contract: "Contract",
  product: "Product call",
  risk: "Risk",
  accessibility: "Accessibility",
} as const;

export const TEXTAREA =
  "block w-full max-w-reading resize-y rounded-control border border-line bg-code px-3 py-2 text-base placeholder:text-muted";

/** For an excerpt of a file an earlier stop owns: one line that points at those rows instead of a second diff. */
const Also = ({ stop, onFlash }: { readonly stop: StopView; readonly onFlash: (path: string, index: number, start: number, end: number) => void }) => {
  const { page } = usePage();
  const elsewhere = stop.excerpts.filter((excerpt) => !stop.owns.includes(excerpt.path));
  if (elsewhere.length === 0) return null;
  return (
    <p data-also className="mt-3 text-small">
      Also in this stop:{" "}
      {elsewhere.map((excerpt, at) => {
        const model = page.files.get(excerpt.path);
        if (model === undefined) return null;
        const lines = parseRows(model.file.patch ?? "")
          .slice(excerpt.start_row, excerpt.end_row + 1)
          .map((row) => row[excerpt.side])
          .filter((line) => line !== undefined);
        const first = lines[0];
        const last = lines.at(-1);
        const span = first === undefined ? "" : first === last ? ` line ${first}` : ` lines ${first}–${last}`;
        return (
          <span key={at}>
            {at === 0 ? null : ", "}
            <a
              href={`#f${model.index}-r${excerpt.start_row}`}
              onClick={(event) => {
                event.preventDefault();
                onFlash(excerpt.path, model.index, excerpt.start_row, excerpt.end_row);
              }}
              className="text-link underline underline-offset-3"
            >
              <code>{excerpt.path}</code>
              {span} ↑
            </a>
          </span>
        );
      })}
    </p>
  );
};

export const StopSection = ({
  stop,
  split,
  onFlash,
  onAsk,
}: {
  readonly stop: StopView;
  readonly split: boolean;
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
      data-closing={stop.closing ? "" : undefined}
      className="mt-10 scroll-mt-(--sticky-top) border-t border-separator pt-6 first:mt-0"
    >
      <div data-stop-head className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={`stop-${stop.index + 1}-title`} tabIndex={-1} className="scroll-mt-(--sticky-top) text-heading font-semibold">
          <span className="mr-2 font-mono text-reading font-normal text-muted">{stop.index + 1}</span>
          <span>{stop.title}</span>
        </h2>
        <span className="text-small text-muted">
          {count(owned.length, "file")}
          {viewed === 0 ? "" : ` · ${viewed} viewed`}
        </span>
      </div>
      {stop.summary.trim() === "" ? null : (
        <div className="mt-2">
          <Prose text={stop.summary} />
        </div>
      )}
      {stop.attention === null ? null : (
        <p data-attention className="mt-3 max-w-reading border-l-2 border-action pl-3.5">
          <strong className="text-action">{ATTENTION_LEAD[stop.attention.kind]}.</strong> <Inline text={stop.attention.note} />
        </p>
      )}
      <Also stop={stop} onFlash={onFlash} />
      {owned.map((model) => (
        <FileBlock key={model.file.path} model={model} split={split} />
      ))}
      {stop.questions.length === 0 || !page.writable ? null : (
        <div role="group" aria-label="Questions to ask" className="mt-3 flex flex-wrap gap-2">
          {stop.questions.map((question) => (
            <button
              key={question}
              type="button"
              data-question={question}
              onClick={() => onAsk(question)}
              className={cn(TOUCH_TARGET, "inline-flex min-h-7 cursor-pointer items-center gap-2 rounded-control border border-line bg-raised px-2.5 py-0.5 text-left text-small hover:bg-subtle")}
            >
              <span aria-hidden="true" className="font-bold text-accent">
                ?
              </span>
              <Inline text={question} />
            </button>
          ))}
        </div>
      )}
    </section>
  );
};

const END_SECTION = "mt-12 scroll-mt-(--sticky-top) border-t border-separator pt-6";

/**
 * Inline comments on files that left the round, such as a reverted or renamed file. No file block shows them, so
 * they get their own section; otherwise their answers could never be read or accepted.
 */
export const Departed = () => {
  const { page } = usePage();
  const setMoving = useAtomSet(reattachAtom);
  if (page.departed.length === 0) return null;
  return (
    <section id="departed" data-end-section className={END_SECTION}>
      <h2 className="text-heading font-semibold">Files that left the round</h2>
      <div className="mt-3 rounded-panel border border-separator bg-surface">
        {page.departed.map((comment) => (
          <Orphan
            key={comment.id}
            comment={comment}
            withPath
            onMove={() => {
              setMoving(comment.id);
              toast("Select the lines this comment is about, with the + button or by dragging the line numbers. Esc cancels.");
            }}
          />
        ))}
      </div>
    </section>
  );
};

export const General = ({ textarea }: { readonly textarea: React.RefObject<HTMLTextAreaElement | null> }) => {
  const { page } = usePage();
  const act = useAct();
  const [body, setBody] = useAtom(generalDraftAtom);
  const [busy, setBusy] = useState(false);
  // Set at once, unlike `busy`: Ctrl+Enter twice must send once.
  const sending = useRef(false);
  // A closed review has nothing to add: the section shows only what was said.
  if (!page.writable && page.general.length === 0) return null;
  const send = async (question: boolean) => {
    const text = body.trim();
    if (text === "") return textarea.current?.focus();
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    const outcome = await act({ kind: "general_comment", body: text, ...(question ? { question: true } : {}) });
    sending.current = false;
    setBusy(false);
    if (outcome.ok) setBody((now) => (now === body ? "" : now));
  };
  return (
    <section id="general" data-end-section className={END_SECTION}>
      <h2 className="text-heading font-semibold">On the whole change</h2>
      {page.general.length === 0 ? null : (
        <div className="mt-3 flex flex-col gap-3">
          {page.general.map((comment) => (
            <div key={comment.id} className="rounded-panel border border-separator bg-surface px-3 py-2">
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
          <textarea
            ref={textarea}
            id="general-body"
            rows={2}
            readOnly={busy}
            value={body}
            placeholder="A question, a concern, or a direction for the agents"
            onChange={(event) => setBody(event.currentTarget.value)}
            onKeyDown={submitOnModEnter}
            className={TEXTAREA}
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
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const section = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [engaged, setEngaged] = useState(false);
  const [shownRound, setShownRound] = useState<RoundNumber>(page.round.round);
  const behind = shownRound !== page.round.round;
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
      <section id="finish" ref={section} data-end-section data-round={page.round.round} className={END_SECTION}>
        <h2 id="finish-title" ref={heading} tabIndex={-1} className="text-heading font-semibold">
          Round {page.round.round} finished · {VERDICT_TEXT[submission.verdict]} · <Time at={submission.submitted_at} />
        </h2>
        <p data-submission className="mt-2 max-w-reading">
          {VERDICT_DONE[submission.verdict].replace(/^you/, "You")} at <Time at={submission.submitted_at} />
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
      className={END_SECTION}
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
        className="mt-3"
        onSubmit={async (event) => {
          event.preventDefault();
          if (sending.current) return;
          sending.current = true;
          setBusy(true);
          const outcome = await act({ kind: "submit", round: shownRound, verdict: draft.verdict, body: draft.body });
          sending.current = false;
          setBusy(false);
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
                "inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-control border px-3 font-semibold",
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
        <textarea
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
          className={cn(TEXTAREA, "mt-3")}
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
