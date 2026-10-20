/** The finish: the last section of the review page, where the reviewer gives the round its verdict. */
import { useAtom } from "@effect/atom-react";
import { useEffect, useRef, useState } from "react";
import type { Verdict } from "../../schema/feedback.ts";
import type { RoundNumber } from "../../schema/primitives.ts";
import { VERDICT_DONE, VERDICT_TEXT } from "../names.ts";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Time } from "../ui/text.tsx";
import { Textarea } from "../ui/textarea.tsx";
import { toast } from "../ui/toast.tsx";
import { useAct, usePage, useSending } from "./act.ts";
import { ACTIONS_CLASS, submitOnModEnter } from "./Thread.tsx";
import { finishDraftAtom } from "./ui.ts";
import { finishState } from "./view.ts";

/** The finish as a card, open or finished, so the page ends on something to act on. It follows the whole change. */
const FINISH_CARD = "mt-6 scroll-mt-(--sticky-top) rounded-panel bg-surface p-5";

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
  const { id, page } = usePage();
  const act = useAct();
  const [draft, setDraft] = useAtom(finishDraftAtom(id));
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
