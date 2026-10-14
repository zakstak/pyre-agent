/** Comment threads: the comment, every reply, and the reviewer's next move, as GitHub shows a review thread. */
import { RegistryContext, useAtom, useAtomSet } from "@effect/atom-react";
import { useContext, useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import type { Comment, Disposition, Reply } from "../../schema/feedback.ts";
import type { Thread as AgentThread } from "../../schema/thread.ts";
import { commentElementId } from "../../review/next.ts";
import type { Standing } from "../../review/progress.ts";
import { type Turn, turnOf } from "../../review/queries.ts";
import { threadName, threadNameOf } from "../names.ts";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { ThreadName } from "../ui/target.tsx";
import { Time } from "../ui/text.tsx";
import { Textarea } from "../ui/textarea.tsx";
import { toast } from "../ui/toast.tsx";
import { useAct, usePage, useSending } from "./act.ts";
import type { InlineComment } from "./diff-model.ts";
import { reattachAtom, replyAtom } from "./ui.ts";
import { orphanPlace } from "./view.ts";

type Tone = "neutral" | "ok" | "warn" | "turn" | "wait";

const TONE: Readonly<Record<Tone, string>> = {
  neutral: "border-separator text-ink",
  ok: "border-success text-success",
  warn: "border-warning text-warning",
  turn: "border-action text-action",
  wait: "border-separator text-muted",
};

const Chip = ({ tone = "neutral", title, children }: { readonly tone?: Tone; readonly title?: string; readonly children: string }) => (
  <span
    data-chip
    title={title}
    className={cn("inline-flex items-center rounded-full border px-2 text-chip leading-5 font-semibold", TONE[tone])}
  >
    {children}
  </span>
);

const DISPOSITION: Readonly<Record<Disposition, { readonly label: string; readonly tone: Tone }>> = {
  fixed: { label: "Fixed", tone: "ok" },
  rejected: { label: "Rejected", tone: "warn" },
  deferred: { label: "Deferred", tone: "neutral" },
  question: { label: "Question", tone: "neutral" },
  answered: { label: "Answered", tone: "ok" },
};

/** Who the comment waits for: the agent that answered last, the only thread, or the agents. */
const waitingFor = (comment: Comment, threads: ReadonlyArray<AgentThread>) => {
  const answered = comment.replies.findLast((item) => item.actor === "agent");
  if (answered !== undefined) return threadNameOf(threads, answered.thread);
  const only = threads.length === 1 ? threads[0] : undefined;
  return only === undefined ? "the agents" : threadName(only.label);
};

/** What the comment's state says: whose turn it is, or how it ended. */
const TurnChip = ({ comment, standing }: { readonly comment: Comment; readonly standing: Standing }) => {
  const { page } = usePage();
  switch (standing) {
    case "pending":
      return <Chip title="Sent with your review">Pending</Chip>;
    case "reviewer":
      return <Chip tone="turn">Your turn</Chip>;
    case "agent":
      return <Chip tone="wait">{`Waiting for ${waitingFor(comment, page.snapshot.threads)}`}</Chip>;
    case "resolved":
      // An accept with no answer before it is the reviewer taking the comment back.
      return comment.replies.some((item) => item.actor !== "reviewer") ? (
        <Chip tone="ok">Resolved</Chip>
      ) : (
        <Chip>Withdrawn</Chip>
      );
  }
};

const By = ({ children }: { readonly children: React.ReactNode }) => (
  <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-small text-muted [&_strong]:text-ink">{children}</p>
);

const Body = ({ text }: { readonly text: string }) => (
  <p className="mt-1 max-w-reading whitespace-pre-wrap break-words text-ink">{text}</p>
);

const ReplyItem = ({ item }: { readonly item: Reply }) => {
  const { page } = usePage();
  switch (item.actor) {
    case "agent": {
      const thread = page.snapshot.threads.find((candidate) => candidate.id === item.thread);
      const disposition = DISPOSITION[item.disposition];
      return (
        <li data-reply="agent" className="border-t border-separator pt-2">
          <By>
            <strong>{thread === undefined ? item.thread : <ThreadName thread={thread} />}</strong>
            <Chip tone={disposition.tone}>{disposition.label}</Chip>
            <Time at={item.created_at} />
          </By>
          <Body text={item.body} />
          {item.disposition === "deferred" ? (
            <p className="mt-1 text-small">
              <strong>Blocked by:</strong> {item.blocker}
            </p>
          ) : null}
          {item.disposition === "fixed" ? (
            <p className="mt-1 text-small text-muted">
              Fixed in{" "}
              {"commit" in item.fixed_in ? (
                <>
                  commit <code>{item.fixed_in.commit.slice(0, 7)}</code>
                </>
              ) : (
                <>
                  file version <code>{item.fixed_in.fingerprint.slice(0, 7)}</code>
                </>
              )}
            </p>
          ) : null}
        </li>
      );
    }
    case "reviewer":
      return (
        <li data-reply="reviewer" className="border-t border-separator pt-2">
          <By>
            <strong>You</strong>
            {item.action === "accept" ? <span>accepted</span> : item.action === "reopen" ? <span>reopened</span> : null}
            <Time at={item.created_at} />
          </By>
          {item.body.trim() === "" ? null : <Body text={item.body} />}
        </li>
      );
    case "github":
      return (
        <li data-reply="github" className="border-t border-separator pt-2">
          <By>
            <strong>{item.github.author ?? "ghost"}</strong>
            <span>on GitHub</span>
            <Time at={item.created_at} />
          </By>
          <Body text={item.body} />
        </li>
      );
  }
};

/** Ctrl or Cmd with Enter sends the form a text box is in. */
export const submitOnModEnter = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }
};

export const ACTIONS_CLASS = "mt-2 flex flex-wrap items-center gap-2";

/** The reviewer's moves on a thread, under its last message. Reply opens a text box in place. */
const Moves = ({
  comment,
  turn,
  extra,
  onMoved,
}: {
  readonly comment: Comment;
  readonly turn: Turn;
  readonly extra: React.ReactNode;
  readonly onMoved: (outcome: "sent" | "refused") => void;
}) => {
  const act = useAct();
  const registry = useContext(RegistryContext);
  const [reply, setReply] = useAtom(replyAtom(comment.id));
  const { busy, run } = useSending();
  const area = useRef<HTMLTextAreaElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  /** Hides the editor, keeping its text, and puts focus back on Reply in the same frame. */
  const closeEditor = () => {
    flushSync(() => setReply((now) => ({ ...now, open: false })));
    opener.current?.focus();
  };
  /** Sends a move. `typed` is the reply box's text as it was, so text typed meanwhile stays in the box. */
  const send = async (action: "reply" | "accept" | "reopen", body: string, typed?: string) => {
    const outcome = await run(() => {
      onMoved("sent");
      return act({ kind: "reply", comment: comment.id, action, body });
    });
    if (outcome === undefined) return;
    if (!outcome.ok) return onMoved("refused");
    if (typed !== undefined) setReply((now) => (now.body === typed ? { open: false, body: "" } : { ...now, open: false }));
  };
  if (turn === "resolved")
    return (
      <div data-thread-actions className={ACTIONS_CLASS}>
        <Button size="sm" disabled={busy} onClick={() => void send("reopen", "Reopened.")}>
          Reopen
        </Button>
        {extra}
      </div>
    );
  const editorId = `reply-${comment.id}`;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const body = reply.body.trim();
        if (body === "") return area.current?.focus();
        void send("reply", body, reply.body);
      }}
    >
      {reply.open ? (
        <div className="mt-2">
          <label className="sr-only" htmlFor={editorId}>
            Reply
          </label>
          <Textarea
            ref={area}
            id={editorId}
            readOnly={busy}
            rows={3}
            value={reply.body}
            placeholder={turn === "agent" ? "Add to the comment" : "Reply to the answer"}
            onChange={(event) => setReply({ open: true, body: event.currentTarget.value })}
            onKeyDown={(event) => {
              submitOnModEnter(event);
              // While a comment is being moved, Esc ends the move and leaves the reply open.
              if (event.key === "Escape" && registry.get(reattachAtom) === undefined) {
                event.preventDefault();
                closeEditor();
              }
            }}
          />
          <div data-thread-actions className={ACTIONS_CLASS}>
            <Button type="submit" size="sm" variant="primary" disabled={busy}>
              Reply
            </Button>
            <Button
              size="sm"
              variant="quiet"
              onClick={closeEditor}
            >
              Cancel
            </Button>
            <span className="text-small text-muted">Ctrl+Enter · Esc</span>
          </div>
        </div>
      ) : (
        <div data-thread-actions className={ACTIONS_CLASS}>
          {turn === "reviewer" ? (
            <Button size="sm" disabled={busy} title="The answer settles the comment" data-accept onClick={() => void send("accept", reply.body.trim(), reply.body)}>
              Accept
            </Button>
          ) : null}
          <Button
            ref={opener}
            size="sm"
            variant="quiet"
            onClick={() => {
              flushSync(() => setReply((now) => ({ ...now, open: true })));
              area.current?.focus();
            }}
          >
            Reply
          </Button>
          {turn === "agent" ? (
            <Button size="sm" variant="quiet" disabled={busy} title="Take the comment back" onClick={() => void send("accept", reply.body.trim(), reply.body)}>
              Withdraw
            </Button>
          ) : null}
          {extra}
        </div>
      )}
    </form>
  );
};

/** One comment with its conversation and the reviewer's moves. `extra` adds a move, such as moving the comment. */
export const ThreadView = ({ comment, extra }: { readonly comment: Comment; readonly extra?: React.ReactNode }) => {
  const { page } = usePage();
  const turn = turnOf(comment);
  const standing = page.standing(comment);
  const article = useRef<HTMLElement>(null);
  /**
   * The thread as it was when the reviewer made a move. When the move shows, the thread's actions have changed, and
   * focus goes to its first one, or the thread itself, once: a later answer from an agent leaves focus alone.
   */
  const pending = useRef<{ readonly turn: string; readonly replies: number } | undefined>(undefined);
  useEffect(() => {
    const was = pending.current;
    if (was === undefined || (was.turn === turn && was.replies === comment.replies.length)) return;
    pending.current = undefined;
    const target = article.current?.querySelector<HTMLElement>("[data-thread-actions] button") ?? article.current;
    target?.focus({ preventScroll: true });
  }, [turn, comment.replies.length]);
  // The reattachment's reason, only where it found the lines somewhere else; the comment already sits on them.
  const reason =
    comment.kind === "inline" && comment.attachment.state === "attached" && comment.attachment.reason !== "Same patch."
      ? comment.attachment.reason
      : undefined;
  return (
    <article
      ref={article}
      id={commentElementId(comment.id)}
      data-comment={comment.id}
      data-turn={turn}
      data-standing={standing}
      aria-label="Comment"
      tabIndex={-1}
      className={cn(
        "scroll-mt-(--sticky-top) border-l-2 py-1 pl-3 [&+&]:mt-3",
        turn === "reviewer" ? "border-action" : turn === "resolved" ? "border-separator" : "border-accent",
      )}
    >
      <By>
        {comment.source.kind === "github" ? (
          <>
            <strong>{comment.source.author ?? "ghost"}</strong>
            <span>on GitHub</span>
          </>
        ) : (
          <strong>You</strong>
        )}
        <Time at={comment.created_at} />
        <TurnChip comment={comment} standing={standing} />
        {reason === undefined ? null : (
          <span title={reason} className="underline decoration-dotted">
            moved
          </span>
        )}
      </By>
      <Body text={comment.body} />
      {comment.replies.length === 0 ? null : (
        <ol className="mt-2 flex list-none flex-col gap-2 p-0">
          {comment.replies.map((item) => (
            <ReplyItem key={item.id} item={item} />
          ))}
        </ol>
      )}
      {page.writable ? <Moves comment={comment} turn={turn} extra={extra} onMoved={(outcome) => {
            pending.current = outcome === "sent" ? { turn, replies: comment.replies.length } : undefined;
          }} /> : null}
    </article>
  );
};

/** An inline comment whose lines are not in this round, with where it pointed and a way to move it. */
export const Orphan = ({ comment, withPath = false }: { readonly comment: InlineComment; readonly withPath?: boolean }) => {
  const { page } = usePage();
  const setMoving = useAtomSet(reattachAtom);
  const move = () => {
    setMoving(comment.id);
    toast("Select the lines this comment is about, with the + button or by dragging the line numbers. Esc cancels.");
  };
  return (
    <div className="border-t border-separator px-3 py-3 first:border-t-0">
      <p className="text-small text-muted">
        {withPath ? (
          <>
            <code>{comment.anchor.path}</code> ·{" "}
          </>
        ) : null}
        {orphanPlace(comment, page.round.round)}
        {comment.attachment.state === "orphan" ? ` · ${comment.attachment.reason}` : ""}
      </p>
      <pre className="my-2 overflow-x-auto rounded-control bg-code px-3 py-2 text-technical">
        <code>{comment.anchor.quote}</code>
      </pre>
      <ThreadView
        comment={comment}
        extra={
          page.writable ? (
            <Button size="sm" variant="quiet" onClick={move}>
              Move to other lines
            </Button>
          ) : null
        }
      />
    </div>
  );
};
