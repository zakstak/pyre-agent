/**
 * Comment threads: the comment, every reply, and the reviewer's next move, as GitHub shows a review thread. The
 * reviewer edits or deletes a comment of theirs from the menu at its top right.
 */
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Menu } from "@base-ui/react/menu";
import { RegistryContext, useAtom, useAtomSet } from "@effect/atom-react";
import { Ellipsis, Pencil, Trash } from "lucide-react";
import { useContext, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { Comment, Disposition, Reply } from "../../schema/feedback.ts";
import type { Thread as AgentThread } from "../../schema/thread.ts";
import { commentElementId } from "../../review/next.ts";
import type { Standing } from "../../review/progress.ts";
import {
  canDelete,
  canEdit,
  isPending,
  type OwnComment,
  type Turn,
  turnOf,
} from "../../review/queries.ts";
import { threadName, threadNameOf } from "../names.ts";
import { Button, buttonVariants, TOUCH_TARGET } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Time, timeTitle } from "../ui/text.tsx";
import { Textarea } from "../ui/textarea.tsx";
import { AgentVoice, Voice, voiceOf } from "../ui/voice.tsx";
import { toast } from "../ui/toast.tsx";
import { useAct, useDraftStatus, usePage, useSending } from "./act.ts";
import type { InlineComment } from "./diff-model.ts";
import { useKeepDraft, useSendDraft } from "./saving.ts";
import {
  CommentBody,
  replacedBy,
  SuggestButton,
  SuggestionPreview,
} from "./Suggestion.tsx";
import { canSuggest } from "./suggest.ts";
import { editAtom, reattachAtom, replyAtom } from "./ui.ts";
import { orphanPlace } from "./view.ts";

type Tone = "neutral" | "ok" | "warn" | "turn" | "wait";

const TONE: Readonly<Record<Tone, string>> = {
  neutral: "border-separator text-ink",
  ok: "border-success text-success",
  warn: "border-warning text-warning",
  turn: "border-action text-action",
  wait: "border-separator text-muted",
};

const Chip = ({
  tone = "neutral",
  title,
  children,
}: {
  readonly tone?: Tone;
  readonly title?: string;
  readonly children: string;
}) => (
  <span
    data-chip
    title={title}
    className={cn(
      "inline-flex items-center rounded-full border px-2 text-chip leading-5 font-semibold",
      TONE[tone],
    )}
  >
    {children}
  </span>
);

const DISPOSITION: Readonly<
  Record<Disposition, { readonly label: string; readonly tone: Tone }>
> = {
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
const TurnChip = ({
  comment,
  standing,
}: {
  readonly comment: Comment;
  readonly standing: Standing;
}) => {
  const { page } = usePage();
  switch (standing) {
    case "pending":
      return (
        <Chip tone="warn" title="Sent with your review">
          Pending
        </Chip>
      );
    case "reviewer":
      return <Chip tone="turn">Your turn</Chip>;
    case "agent":
      return (
        <Chip tone="wait">{`Waiting for ${waitingFor(comment, page.snapshot.threads)}`}</Chip>
      );
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
  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-muted">
    {children}
  </p>
);

/** A GitHub author as a voice; a deleted account is GitHub's "ghost". */
const GitHubVoice = ({ login }: { readonly login: string | null }) => (
  <Voice kind={voiceOf(login ?? "ghost")} name={login ?? "ghost"} />
);

/** The thread's bar: the voice that started the comment. Whose turn it is, the chip says. */
const BAR: Readonly<Record<"you" | "github" | "bot", string>> = {
  you: "border-action",
  github: "border-link",
  bot: "border-separator",
};

const Body = ({ text }: { readonly text: string }) => (
  <p className="mt-1 whitespace-pre-wrap break-words text-ink">{text}</p>
);

const ReplyItem = ({ item }: { readonly item: Reply }) => {
  const { page } = usePage();
  switch (item.actor) {
    case "agent": {
      const thread = page.snapshot.threads.find(
        (candidate) => candidate.id === item.thread,
      );
      const disposition = DISPOSITION[item.disposition];
      return (
        <li data-reply="agent" className="pt-3">
          <By>
            {thread === undefined ? (
              <Voice kind="agent" name={item.thread} />
            ) : (
              <AgentVoice label={thread.label} />
            )}
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
                  file version{" "}
                  <code>{item.fixed_in.fingerprint.slice(0, 7)}</code>
                </>
              )}
            </p>
          ) : null}
        </li>
      );
    }
    case "reviewer":
      return (
        <li data-reply="reviewer" className="pt-3">
          <By>
            <Voice kind="you" name="You" />
            {item.action === "accept" ? (
              <span>accepted</span>
            ) : item.action === "reopen" ? (
              <span>reopened</span>
            ) : null}
            <Time at={item.created_at} />
          </By>
          {item.body.trim() === "" ? null : <Body text={item.body} />}
        </li>
      );
    case "github":
      return (
        <li data-reply="github" className="pt-3">
          <By>
            <GitHubVoice login={item.github.author} />
            <span>on {new URL(item.github.url).host}</span>
            <Time at={item.created_at} />
          </By>
          <Body text={item.body} />
        </li>
      );
  }
};

/** Ctrl or Cmd with Enter sends the form a text box is in. */
export const submitOnModEnter = (
  event: React.KeyboardEvent<HTMLTextAreaElement>,
) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }
};

export const ACTIONS_CLASS = "mt-2 flex flex-wrap items-center gap-2";

/** Whether the reviewer's unsent text is saved, beside a box that holds some. */
export const DraftNote = ({ shown }: { readonly shown: boolean }) => {
  const status = useDraftStatus();
  if (!shown) return null;
  switch (status.state) {
    case "idle":
      return null;
    case "saving":
    case "saved":
      return (
        <span
          data-draft-status={status.state}
          className="text-small text-muted"
        >
          {status.state === "saving" ? "Saving draft…" : "Draft saved"}
        </span>
      );
    case "failed":
      return (
        <span
          data-draft-status="failed"
          role="alert"
          className="text-small text-danger"
        >
          Draft not saved: {status.message}
        </span>
      );
  }
};

/**
 * The reviewer's moves on a thread, under its last message. Reply opens a text box in place, whose text the server
 * keeps until it is sent or cancelled.
 */
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
  const { id } = usePage();
  const act = useAct();
  const registry = useContext(RegistryContext);
  const [reply, setReply] = useAtom(
    replyAtom({ review: id, comment: comment.id }),
  );
  const slot = { kind: "reply", comment: comment.id } as const;
  useKeepDraft(
    slot,
    reply.body.trim() === "" ? undefined : { ...slot, body: reply.body },
  );
  const sendDraft = useSendDraft(slot);
  const { busy, run } = useSending();
  const area = useRef<HTMLTextAreaElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  /** Hides the editor, keeping its text, which stays saved for when it opens again, and puts focus back on Reply. */
  const closeEditor = () => {
    flushSync(() => setReply((now) => ({ ...now, open: false })));
    opener.current?.focus();
  };
  /** Hides the editor and drops its text, and with it the saved draft. */
  const cancel = () => {
    flushSync(() => setReply({ open: false, body: "" }));
    opener.current?.focus();
  };
  /** Sends a move. `typed` is the reply box's text as it was, so text typed meanwhile stays in the box. */
  const send = async (
    action: "reply" | "accept" | "reopen",
    body: string,
    typed?: string,
  ) => {
    const outcome = await run(() => {
      onMoved("sent");
      // Every reply, an accept or a reopen too, empties the reply box's slot on the server.
      return sendDraft(() =>
        act({ kind: "reply", comment: comment.id, action, body }),
      );
    });
    if (outcome === undefined) return;
    if (!outcome.ok) return onMoved("refused");
    if (typed !== undefined)
      setReply((now) =>
        now.body === typed
          ? { open: false, body: "" }
          : { ...now, open: false },
      );
  };
  // Nobody has seen a pending comment, so there is nothing to reply to: its menu edits or deletes it.
  if (isPending(comment))
    return extra === undefined || extra === null ? null : (
      <div data-thread-actions className={ACTIONS_CLASS}>
        {extra}
      </div>
    );
  if (turn === "resolved")
    return (
      <div data-thread-actions className={ACTIONS_CLASS}>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => void send("reopen", "Reopened.")}
        >
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
            placeholder={
              turn === "agent" ? "Add to the comment" : "Reply to the answer"
            }
            onChange={(event) =>
              setReply({ open: true, body: event.currentTarget.value })
            }
            onKeyDown={(event) => {
              submitOnModEnter(event);
              // While a comment is being moved, Esc ends the move and leaves the reply open.
              if (
                event.key === "Escape" &&
                registry.get(reattachAtom(id)) === undefined
              ) {
                event.preventDefault();
                closeEditor();
              }
            }}
          />
          <div data-thread-actions className={ACTIONS_CLASS}>
            <Button type="submit" size="sm" variant="primary" disabled={busy}>
              Reply
            </Button>
            <Button size="sm" variant="quiet" disabled={busy} onClick={cancel}>
              Cancel
            </Button>
            <span className="text-small text-muted">Ctrl+Enter · Esc</span>
            <DraftNote shown={reply.body.trim() !== ""} />
          </div>
        </div>
      ) : (
        <div data-thread-actions className={ACTIONS_CLASS}>
          {turn === "reviewer" ? (
            <Button
              size="sm"
              disabled={busy}
              title="The answer settles the comment"
              data-accept
              onClick={() => void send("accept", reply.body.trim(), reply.body)}
            >
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
            <Button
              size="sm"
              variant="quiet"
              disabled={busy}
              title="Take the comment back"
              onClick={() => void send("accept", reply.body.trim(), reply.body)}
            >
              Withdraw
            </Button>
          ) : null}
          {extra}
        </div>
      )}
    </form>
  );
};

/** A menu item's look: a row of the popup, lit while the pointer or the keyboard is on it. */
const MENU_ITEM = cn(
  TOUCH_TARGET,
  "flex h-8 cursor-pointer items-center gap-2 px-3 outline-none select-none data-highlighted:bg-subtle",
);

/** The menu of a comment of the reviewer's: Edit, and Delete while nobody has replied. */
const CommentMenu = ({
  comment,
  trigger,
  onEdit,
  onDelete,
}: {
  readonly comment: OwnComment;
  readonly trigger: React.RefObject<HTMLButtonElement | null>;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}) => {
  // An item moves focus itself, to the editor or the dialog; Esc and a click outside give it back to the trigger.
  const chosen = useRef(false);
  const choose = (then: () => void) => () => {
    chosen.current = true;
    then();
  };
  return (
    <Menu.Root
      modal={false}
      onOpenChange={(open) => {
        if (open) chosen.current = false;
      }}
    >
      <Menu.Trigger
        ref={trigger}
        data-comment-menu
        aria-label="Comment actions"
        title="Comment actions"
        className={cn(
          buttonVariants({ variant: "quiet", size: "sm" }),
          "-my-1 px-1.5 text-muted hover:text-ink",
        )}
      >
        <Ellipsis aria-hidden="true" className="size-4" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={4} align="end" className="z-40">
          <Menu.Popup
            finalFocus={() => !chosen.current}
            className="min-w-36 rounded-control border border-line bg-raised py-1 text-small shadow-md outline-none"
          >
            <Menu.Item
              data-edit-comment
              onClick={choose(onEdit)}
              className={MENU_ITEM}
            >
              <Pencil aria-hidden="true" className="size-3.5" />
              Edit
            </Menu.Item>
            {canDelete(comment) ? (
              <Menu.Item
                data-delete-comment
                onClick={choose(onDelete)}
                className={cn(MENU_ITEM, "text-danger")}
              >
                <Trash aria-hidden="true" className="size-3.5" />
                Delete
              </Menu.Item>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
};

/** Asks before a comment goes for good. `onDelete` resolves once the server answered. */
const DeleteDialog = ({
  comment,
  open,
  onOpenChange,
  onDelete,
  returnFocus,
}: {
  readonly comment: OwnComment;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDelete: () => Promise<void>;
  /** Where focus goes when the dialog closes. */
  readonly returnFocus: () => HTMLElement | true;
}) => {
  const { busy, run } = useSending();
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-40 bg-black/30" />
        <AlertDialog.Popup
          data-delete-dialog
          finalFocus={returnFocus}
          className="fixed top-1/2 left-1/2 z-50 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-panel border border-line bg-raised p-5 shadow-lg outline-none"
        >
          <AlertDialog.Title className="text-heading font-semibold">
            Delete this comment?
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-1 text-small text-muted">
            {isPending(comment)
              ? "It is pending: no agent has seen it."
              : "The agents saw it. It goes from the review and from what they read next."}
          </AlertDialog.Description>
          <div className="mt-4 flex justify-end gap-2">
            <AlertDialog.Close
              disabled={busy}
              className={buttonVariants({ variant: "quiet", size: "sm" })}
            >
              Cancel
            </AlertDialog.Close>
            <Button
              size="sm"
              variant="danger"
              disabled={busy}
              data-confirm-delete
              onClick={() => void run(onDelete)}
            >
              Delete
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
};

/**
 * A comment's text being changed in place, with the preview of a suggestion in it. Its text is the edit box's draft;
 * `onClose` hides the box, after Cancel or once the server took the change.
 */
const EditBox = ({
  comment,
  onClose,
}: {
  readonly comment: OwnComment;
  readonly onClose: () => void;
}) => {
  const { id } = usePage();
  const act = useAct();
  const registry = useContext(RegistryContext);
  const [edit, setEdit] = useAtom(
    editAtom({ review: id, comment: comment.id }),
  );
  const sendDraft = useSendDraft({ kind: "edit", comment: comment.id });
  const { busy, run } = useSending();
  const area = useRef<HTMLTextAreaElement>(null);
  const textId = `edit-${comment.id}`;
  const replaced = comment.kind === "inline" ? replacedBy(comment) : undefined;
  return (
    <form
      data-edit-box
      className="mt-2"
      onSubmit={async (event) => {
        event.preventDefault();
        const body = edit.body.trim();
        if (body === "") return area.current?.focus();
        const outcome = await run(() =>
          sendDraft(() =>
            act({ kind: "edit_comment", comment: comment.id, body }),
          ),
        );
        if (outcome?.ok === true) onClose();
      }}
    >
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <label htmlFor={textId} className="text-small text-muted">
          Edit your comment
        </label>
        {!canSuggest(replaced) ? null : (
          <SuggestButton
            area={area}
            replaced={replaced}
            disabled={busy}
            onBody={(body) => setEdit({ open: true, body })}
          />
        )}
      </div>
      <Textarea
        ref={area}
        id={textId}
        rows={3}
        readOnly={busy}
        value={edit.body}
        onChange={(event) =>
          setEdit({ open: true, body: event.currentTarget.value })
        }
        onKeyDown={(event) => {
          submitOnModEnter(event);
          if (
            event.key === "Escape" &&
            !busy &&
            registry.get(reattachAtom(id)) === undefined
          ) {
            event.preventDefault();
            onClose();
          }
        }}
      />
      <SuggestionPreview body={edit.body} replaced={replaced} />
      <div className={ACTIONS_CLASS}>
        <Button type="submit" size="sm" variant="primary" disabled={busy}>
          Update comment
        </Button>
        <Button size="sm" variant="quiet" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <span className="text-small text-muted">Ctrl+Enter · Esc</span>
        <DraftNote shown={edit.body !== comment.body} />
      </div>
    </form>
  );
};

/** Where focus goes when a thread is deleted: the diff it was in, or the box on the whole change, or the page. */
const focusAfterDelete = (article: HTMLElement | null) =>
  article?.closest<HTMLElement>("[role='group'][tabindex]") ??
  document.getElementById("general-body") ??
  document.getElementById("main");

/** One comment with its conversation and the reviewer's moves. `extra` adds a move, such as moving the comment. */
export const ThreadView = ({
  comment,
  extra,
}: {
  readonly comment: Comment;
  readonly extra?: React.ReactNode;
}) => {
  const { id, page } = usePage();
  const act = useAct();
  const turn = turnOf(comment);
  const standing = page.standing(comment);
  const starter =
    comment.source.kind === "github"
      ? voiceOf(comment.source.author ?? "ghost")
      : "you";
  const article = useRef<HTMLElement>(null);
  const menu = useRef<HTMLButtonElement>(null);
  // Where focus goes when the delete dialog closes: back to the menu, or, once the comment is gone, near where it was.
  const afterDelete = useRef<HTMLElement | null>(null);
  const [edit, setEdit] = useAtom(
    editAtom({ review: id, comment: comment.id }),
  );
  const [deleting, setDeleting] = useState(false);
  const own = canEdit(comment) && page.writable ? comment : undefined;
  // An edit box's text is a draft while it differs from the comment; closing the box drops it.
  useKeepDraft(
    { kind: "edit", comment: comment.id },
    own !== undefined && edit.open && edit.body !== comment.body
      ? { kind: "edit", comment: comment.id, body: edit.body }
      : undefined,
  );
  const editing = own !== undefined && edit.open;
  /**
   * Opens the editor on the comment's text, with the caret after it, or closes it and gives focus back to the menu. An
   * editor the page restores when it opens takes no focus: the reviewer has not moved yet.
   */
  const openEditor = () => {
    flushSync(() => setEdit({ open: true, body: comment.body }));
    const box = article.current?.querySelector<HTMLTextAreaElement>(
      "[data-edit-box] textarea",
    );
    box?.focus();
    box?.setSelectionRange(box.value.length, box.value.length);
  };
  const closeEditor = () => {
    flushSync(() => setEdit({ open: false, body: "" }));
    menu.current?.focus();
  };
  /**
   * The thread as it was when the reviewer made a move. When the move shows, the thread's actions have changed, and
   * focus goes to its first one, or the thread itself, once: a later answer from an agent leaves focus alone.
   */
  const pending = useRef<
    { readonly turn: string; readonly replies: number } | undefined
  >(undefined);
  useEffect(() => {
    const was = pending.current;
    if (
      was === undefined ||
      (was.turn === turn && was.replies === comment.replies.length)
    )
      return;
    pending.current = undefined;
    const target =
      article.current?.querySelector<HTMLElement>(
        "[data-thread-actions] button",
      ) ?? article.current;
    target?.focus({ preventScroll: true });
  }, [turn, comment.replies.length]);
  // The reattachment's reason, only where it found the lines somewhere else; the comment already sits on them.
  const reason =
    comment.kind === "inline" &&
    comment.attachment.state === "attached" &&
    comment.attachment.reason !== "Same patch." &&
    comment.attachment.reason !== "Same text."
      ? comment.attachment.reason
      : undefined;
  const edited =
    comment.source.kind === "reviewer" && comment.source.state === "edited"
      ? comment.source.edited_at
      : undefined;
  return (
    <article
      ref={article}
      id={commentElementId(comment.id)}
      data-comment={comment.id}
      data-turn={turn}
      data-standing={standing}
      aria-label={standing === "pending" ? "Pending comment" : "Comment"}
      tabIndex={-1}
      className={cn(
        // A jump lands tinted, and the tint fades: see `land` in navigate.ts.
        "scroll-my-(--scroll-top) border-l-2 py-2 pr-4 pl-3 transition-colors duration-1000 [&+&]:mt-3",
        "data-[landed=arrived]:bg-selected data-[landed=arrived]:transition-none",
        BAR[starter],
        // A pending comment's bar is dashed: it is not sent yet.
        standing === "pending" && "border-dashed",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <By>
          {comment.source.kind === "github" ? (
            <>
              <GitHubVoice login={comment.source.author} />
              <span>on {new URL(comment.source.url).host}</span>
            </>
          ) : (
            <Voice kind="you" name="You" />
          )}
          <Time at={comment.created_at} />
          {edited === undefined ? null : (
            <span data-edited={edited} title={`Edited ${timeTitle(edited)}`}>
              edited<span className="sr-only"> {timeTitle(edited)}</span>
            </span>
          )}
          <TurnChip comment={comment} standing={standing} />
          {reason === undefined ? null : (
            <span title={reason} className="underline decoration-dotted">
              moved
            </span>
          )}
        </By>
        {own === undefined || editing ? null : (
          <CommentMenu
            comment={own}
            trigger={menu}
            onEdit={openEditor}
            onDelete={() => setDeleting(true)}
          />
        )}
      </div>
      {editing ? (
        <EditBox comment={own} onClose={closeEditor} />
      ) : (
        <CommentBody comment={comment} />
      )}
      {comment.replies.length === 0 ? null : (
        <ol className="mt-2 flex list-none flex-col gap-2 p-0">
          {comment.replies.map((item) => (
            <ReplyItem key={item.id} item={item} />
          ))}
        </ol>
      )}
      {page.writable && !editing ? (
        <Moves
          comment={comment}
          turn={turn}
          extra={extra}
          onMoved={(outcome) => {
            pending.current =
              outcome === "sent"
                ? { turn, replies: comment.replies.length }
                : undefined;
          }}
        />
      ) : null}
      {own === undefined ? null : (
        <DeleteDialog
          comment={own}
          open={deleting}
          onOpenChange={setDeleting}
          returnFocus={() => afterDelete.current ?? menu.current ?? true}
          onDelete={async () => {
            const after = focusAfterDelete(article.current);
            const outcome = await act({
              kind: "delete_comment",
              comment: comment.id,
            });
            if (!outcome.ok) return;
            // The thread may go before the dialog closes: focus moves now, and again when the dialog closes.
            afterDelete.current = after;
            setDeleting(false);
            after?.focus({ preventScroll: true });
            toast("Comment deleted.");
          }}
        />
      )}
    </article>
  );
};

/** An inline comment whose lines are not in this round, with where it pointed and a way to move it. */
export const Orphan = ({
  comment,
  withPath = false,
}: {
  readonly comment: InlineComment;
  readonly withPath?: boolean;
}) => {
  const { id, page } = usePage();
  const setMoving = useAtomSet(reattachAtom(id));
  const move = () => {
    setMoving(comment.id);
    toast(
      "Select the lines this comment is about, with the + button or by dragging the line numbers. Esc cancels.",
    );
  };
  return (
    <div className="px-3 py-3">
      <p className="text-small text-muted">
        {withPath ? (
          <>
            <code>{comment.anchor.path}</code> ·{" "}
          </>
        ) : null}
        {orphanPlace(comment, page.round.round)}
        {comment.attachment.state === "orphan"
          ? ` · ${comment.attachment.reason}`
          : ""}
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
