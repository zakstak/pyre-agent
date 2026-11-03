/**
 * The conversation on a stop of the tour: the comments on the stop, the questions it suggests, and a box to ask
 * about it, all inside the stop. A comment here stays on the stop in later rounds that keep the stop; one whose stop
 * a round drops shows with the comments on the whole change. The server keeps the box's text as it is typed.
 */
import { useAtom } from "@effect/atom-react";
import { MessageCircleQuestionMark } from "lucide-react";
import { useRef } from "react";
import { flushSync } from "react-dom";
import { refKey, refOf } from "../../review/stop-anchor.ts";
import type { StopView } from "../../review/tour.ts";
import { Button, TOUCH_TARGET } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Inline } from "../ui/text.tsx";
import { Textarea } from "../ui/textarea.tsx";
import { useAct, usePage, useSending } from "./act.ts";
import { useKeepDraft, useSendDraft } from "./saving.ts";
import {
  ACTIONS_CLASS,
  DraftNote,
  submitOnModEnter,
  ThreadView,
} from "./Thread.tsx";
import { stopDraftAtom } from "./ui.ts";

/** The questions a stop suggests, each of which opens the stop's box with it. */
const Questions = ({
  stop,
  onAsk,
}: {
  readonly stop: StopView;
  readonly onAsk: (question: string) => void;
}) =>
  stop.questions.length === 0 ? null : (
    <div
      role="group"
      aria-label="Questions to ask"
      className="flex flex-wrap gap-2"
    >
      {stop.questions.map((question) => (
        <button
          key={question}
          type="button"
          data-question={question}
          onClick={() => onAsk(question)}
          className={cn(
            TOUCH_TARGET,
            "inline-flex min-h-7 items-center gap-2 rounded-control border border-line bg-raised px-2.5 py-0.5 text-left text-small hover:bg-subtle",
          )}
        >
          <span aria-hidden="true" className="font-bold text-accent">
            ?
          </span>
          <Inline text={question} />
        </button>
      ))}
    </div>
  );

/** The comments on a stop, its questions, and the box that asks about it. A closed review shows only the comments. */
export const StopTalk = ({
  stop,
  className,
}: {
  readonly stop: StopView;
  readonly className?: string;
}) => {
  const { id, page } = usePage();
  const act = useAct();
  const ref = refOf(page.stops, stop);
  const [draft, setDraft] = useAtom(
    stopDraftAtom({ review: id, stop: refKey(ref) }),
  );
  const area = useRef<HTMLTextAreaElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const slot = { kind: "stop", stop: ref } as const;
  useKeepDraft(
    slot,
    draft.body.trim() === "" ? undefined : { ...slot, body: draft.body },
  );
  const sendDraft = useSendDraft(slot);
  const { busy, run } = useSending();
  const comments = page.stopComments.get(stop.index) ?? [];
  const writable = page.writable;
  if (comments.length === 0 && !writable) return null;
  /** Opens the box with `question` before what it holds, unless it starts with it, and puts the caret at the end. */
  const ask = (question?: string) => {
    const now = draft.body;
    const body =
      question === undefined || now.startsWith(question)
        ? now
        : now === ""
          ? question
          : `${question}\n\n${now}`;
    flushSync(() => setDraft({ open: true, body }));
    const box = area.current;
    box?.focus();
    box?.setSelectionRange(body.length, body.length);
  };
  /** Hides the box, keeping its text, and gives focus back to the button that opens it. */
  const close = () => {
    flushSync(() => setDraft((now) => ({ ...now, open: false })));
    opener.current?.focus();
  };
  /** Hides the box and drops its text, and with it the saved draft. */
  const cancel = () => {
    flushSync(() => setDraft({ open: false, body: "" }));
    opener.current?.focus();
  };
  const send = async (question: boolean) => {
    const body = draft.body.trim();
    if (body === "") return area.current?.focus();
    const typed = draft.body;
    const outcome = await run(() =>
      sendDraft(() =>
        act({
          kind: "stop_comment",
          round: page.round.round,
          stop: ref,
          body,
          ...(question ? { question: true } : {}),
        }),
      ),
    );
    if (outcome?.ok !== true) return;
    flushSync(() =>
      setDraft((now) =>
        now.body === typed
          ? { open: false, body: "" }
          : { ...now, open: false },
      ),
    );
    opener.current?.focus();
  };
  const textId = `stop-${stop.index + 1}-ask`;
  return (
    <div
      data-stop-talk={stop.index}
      className={cn("mt-3 flex flex-col gap-3", className)}
    >
      {comments.map((comment) => (
        <div key={comment.id} className="rounded-panel bg-surface px-4 py-3">
          <ThreadView comment={comment} />
        </div>
      ))}
      {!writable ? null : (
        <>
          <div className="flex flex-wrap items-start gap-2">
            <Questions stop={stop} onAsk={ask} />
            <Button
              ref={opener}
              size="sm"
              variant="quiet"
              data-ask-stop
              aria-expanded={draft.open}
              aria-controls={draft.open ? textId : undefined}
              onClick={() => ask()}
            >
              <MessageCircleQuestionMark
                aria-hidden="true"
                className="size-3.5"
              />
              Ask about this stop
            </Button>
          </div>
          {draft.open ? (
            <form
              data-stop-composer
              onSubmit={(event) => {
                event.preventDefault();
                void send(false);
              }}
            >
              <label htmlFor={textId} className="text-small text-muted">
                Comment on stop {stop.index + 1}, {stop.title}
              </label>
              <Textarea
                ref={area}
                id={textId}
                rows={3}
                readOnly={busy}
                value={draft.body}
                placeholder="A question about this stop, or a concern"
                className="mt-1.5"
                onChange={(event) =>
                  setDraft({ open: true, body: event.currentTarget.value })
                }
                onKeyDown={(event) => {
                  submitOnModEnter(event);
                  if (event.key === "Escape" && !busy) {
                    event.preventDefault();
                    close();
                  }
                }}
              />
              <div className={ACTIONS_CLASS}>
                <Button
                  type="submit"
                  size="sm"
                  variant="primary"
                  disabled={busy}
                >
                  Comment
                </Button>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void send(true)}
                >
                  Ask now
                </Button>
                <Button
                  size="sm"
                  variant="quiet"
                  disabled={busy}
                  onClick={cancel}
                >
                  Cancel
                </Button>
                <span className="text-small text-muted">Ctrl+Enter · Esc</span>
                <DraftNote shown={draft.body.trim() !== ""} />
              </div>
            </form>
          ) : null}
        </>
      )}
    </div>
  );
};
