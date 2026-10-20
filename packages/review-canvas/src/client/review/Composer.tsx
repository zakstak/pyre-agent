/**
 * The composer: a comment being written under the rows it is on. Its draft is in the drafts atom, not the component,
 * so a layout change that redraws the table keeps the text, and a new round that changes the rows can stash it.
 */
import { RegistryContext } from "@effect/atom-react";
import type { AtomRegistry } from "effect/reactivity";
import { useContext, useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { Button } from "../ui/button.tsx";
import { Textarea } from "../ui/textarea.tsx";
import { toast } from "../ui/toast.tsx";
import type { PatchDigest, RepoPath, ReviewId } from "../../schema/primitives.ts";
import { useAct, usePage } from "./act.ts";
import { ACTIONS_CLASS, submitOnModEnter } from "./Thread.tsx";
import { type Draft, draftsAtom, reattachAtom, stashAtom } from "./ui.ts";

/**
 * Opens the composer under rows. An unsent draft in another composer moves into it, so picking other lines never
 * loses text, and so does text kept from a draft whose code changed.
 */
export const openDraft = (
  registry: AtomRegistry.AtomRegistry,
  review: ReviewId,
  draft: Omit<Draft, "id" | "body" | "submitting" | "focusPending">,
) => {
  const drafts = registry.get(draftsAtom(review));
  let body = drafts.find((item) => !item.submitting)?.body ?? "";
  if (body === "") {
    body = registry.get(stashAtom(review));
    registry.set(stashAtom(review), "");
  }
  // An ID no draft has, the one it replaces included: composers are keyed by it.
  const id = Math.max(0, ...drafts.map((item) => item.id)) + 1;
  registry.set(draftsAtom(review), [
    ...drafts.filter((item) => item.submitting),
    { ...draft, id, body, submitting: false, focusPending: true },
  ]);
};

/**
 * Takes a review's drafts off patches its round no longer has. A draft whose code changed cannot stay on its rows: its
 * text goes to the stash, which fills the next comment the reviewer opens. Runs whenever a page of the review shows a
 * round, so a draft left on a review the page moved away from is recovered when the page shows that review again.
 */
export const useStashChangedDrafts = (
  review: ReviewId,
  files: ReadonlyMap<RepoPath, { readonly digest: PatchDigest | undefined }> | undefined,
) => {
  const registry = useContext(RegistryContext);
  useEffect(() => {
    if (files === undefined) return;
    const drafts = registry.get(draftsAtom(review));
    const lost = drafts.filter((draft) => !draft.submitting && files.get(draft.path)?.digest !== draft.digest);
    if (lost.length === 0) return;
    registry.set(
      draftsAtom(review),
      drafts.filter((draft) => !lost.includes(draft)),
    );
    const text = lost.map((draft) => draft.body).find((body) => body.trim() !== "");
    if (text !== undefined) {
      registry.set(stashAtom(review), text);
      toast(
        "The code under your comment changed in a new round. Your text is kept: select lines to comment on, and it fills the new comment.",
        "danger",
      );
    }
  }, [review, files, registry]);
};

/** `table` is the ID of the diff table the composer is in, and `range` names the lines it comments on. */
export const Composer = ({ draft, table, range }: { readonly draft: Draft; readonly table: string; readonly range: string }) => {
  const registry = useContext(RegistryContext);
  const { id: review } = usePage();
  const drafts = draftsAtom(review);
  const act = useAct();
  const area = useRef<HTMLTextAreaElement>(null);
  const textId = `composer-${draft.id}`;
  // A composer that is no longer on the page, because a new round changed its rows, cannot take its refusal back.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const update = (change: (draft: Draft) => Draft | undefined) =>
    registry.set(
      drafts,
      registry.get(drafts).flatMap((item) => {
        if (item.id !== draft.id) return [item];
        const next = change(item);
        return next === undefined ? [] : [next];
      }),
    );
  // When it opens, and only then: a redraw, such as a layout change, leaves focus where the reviewer put it.
  useEffect(() => {
    if (!draft.focusPending) return;
    area.current?.focus();
    update((item) => ({ ...item, focusPending: false }));
  }, [draft.focusPending]);
  /** Closes the composer; focus goes back to the + that opened it, or the one on its last line in this layout. */
  const close = () => {
    const inside = area.current?.closest("tr")?.contains(document.activeElement) === true || document.activeElement === document.body;
    // Removed in the same frame as focus moves, so focus never rests on the page itself.
    flushSync(() => update(() => undefined));
    if (inside)
      (
        document.getElementById(draft.opener) ??
        document.querySelector<HTMLElement>(`table[data-table="${table}"] [data-row="${draft.end}"] [data-add-comment]`)
      )?.focus();
  };
  const send = async (question: boolean) => {
    // The atom, not this render's props: Ctrl+Enter twice must send once.
    if (registry.get(drafts).find((item) => item.id === draft.id)?.submitting !== false) return;
    const body = draft.body.trim();
    if (body === "") return area.current?.focus();
    update((item) => ({ ...item, submitting: true }));
    const outcome = await act(
      {
        kind: "comment",
        selection: { path: draft.path, patch_sha256: draft.digest, start_row: draft.start, end_row: draft.end },
        body,
        ...(question ? { question: true } : {}),
      },
      { quiet: true },
    );
    if (outcome.ok) return close();
    if (mounted.current) {
      update((item) => ({ ...item, submitting: false }));
      toast(outcome.message, "danger");
    } else {
      update(() => undefined);
      registry.set(stashAtom(review), body);
      toast(
        `Your comment was not added: ${outcome.message} Your text is kept: select lines to comment on, and it fills the new comment.`,
        "danger",
      );
    }
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void send(false);
      }}
    >
      <p className="mb-1.5 text-small text-muted">
        Comment on <span data-range>{range}</span>
      </p>
      <label className="sr-only" htmlFor={textId}>
        Comment
      </label>
      <Textarea
        ref={area}
        id={textId}
        rows={3}
        required
        readOnly={draft.submitting}
        value={draft.body}
        placeholder="What should change, or what do you want to know?"
        onChange={(event) => {
          const body = event.currentTarget.value;
          update((item) => ({ ...item, body }));
        }}
        onKeyDown={(event) => {
          submitOnModEnter(event);
          // While a comment is being moved, Esc ends the move and leaves the composer open.
          if (event.key === "Escape" && !draft.submitting && registry.get(reattachAtom(review)) === undefined) {
            event.preventDefault();
            close();
          }
        }}
      />
      <div className={ACTIONS_CLASS}>
        <Button type="submit" size="sm" variant="primary" disabled={draft.submitting}>
          Comment
        </Button>
        <Button size="sm" disabled={draft.submitting} onClick={() => void send(true)}>
          Ask now
        </Button>
        <Button size="sm" variant="quiet" disabled={draft.submitting} onClick={close}>
          Cancel
        </Button>
        <span className="text-small text-muted">Ctrl+Enter · Esc</span>
      </div>
    </form>
  );
};
