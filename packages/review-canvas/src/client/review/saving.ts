/**
 * The reviewer's unsent text, kept on the server as they type and put back when the review opens again, in any
 * browser. Each box says what its slot holds now: its text, or nothing when it is empty. The page remembers what it
 * last told the server each slot holds, so a box that redraws, or text the server just gave back, sends nothing, and
 * a box that empties tells the server once.
 */
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Equal, Option } from "effect";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import { useCallback, useContext, useEffect } from "react";
import {
  type Draft,
  type DraftSlot,
  slotKey,
  slotOf,
} from "../../schema/draft.ts";
import type { ReviewId } from "../../schema/primitives.ts";
import { toast } from "../ui/toast.tsx";
import { type Outcome, usePage } from "./act.ts";
import { workspaceAtom } from "./data.ts";
import type { DraftQueue } from "./drafts.ts";
import { type Restored, restoring } from "./restore.ts";
import {
  draftsAtom,
  editAtom,
  finishDraftAtom,
  generalDraftAtom,
  replyAtom,
  stashAtom,
} from "./ui.ts";
import type { PageModel } from "./view.ts";

/** What the page says when a comment's text cannot stay on its lines, because the code under them changed. */
export const STASHED_TEXT =
  "The code under your comment changed in a new round. Your text is kept: select lines to comment on, and it fills the new comment.";

const COMMENT_SLOT: DraftSlot = { kind: "comment" };

/**
 * What the page last told the server each slot of a review holds, by slot key. Undefined until the review's saved
 * drafts are restored: until then the page does not know what the server holds, and saves nothing.
 */
export const heldAtom = Atom.family((_review: ReviewId) =>
  Atom.make<ReadonlyMap<string, Draft> | undefined>(undefined).pipe(
    Atom.keepAlive,
  ),
);

/** The review's draft queue, once the RPC client is ready. */
const useQueue = (review: ReviewId): DraftQueue | undefined =>
  Option.getOrUndefined(AsyncResult.value(useAtomValue(workspaceAtom(review))))
    ?.drafts;

const setHeld = (
  registry: AtomRegistry.AtomRegistry,
  review: ReviewId,
  key: string,
  draft: Draft | undefined,
) => {
  const held = registry.get(heldAtom(review));
  if (held === undefined) return;
  const next = new Map(held);
  if (draft === undefined) next.delete(key);
  else next.set(key, draft);
  registry.set(heldAtom(review), next);
};

/** Has the server hold `draft` in a slot, or nothing, unless the page already told it so. */
const keep = (
  registry: AtomRegistry.AtomRegistry,
  queue: DraftQueue,
  review: ReviewId,
  slot: DraftSlot,
  draft: Draft | undefined,
) => {
  const held = registry.get(heldAtom(review));
  if (held === undefined) return;
  const key = slotKey(slot);
  if (Equal.equals(held.get(key), draft)) return;
  setHeld(registry, review, key, draft);
  if (draft === undefined) void queue.discard(slot);
  else queue.schedule(draft);
};

/**
 * Keeps a box's slot holding `draft`, the box's text as it is now, or nothing for an empty box. Emptying a box, as
 * Cancel does, empties its slot.
 */
export const useKeepDraft = (slot: DraftSlot, draft: Draft | undefined) => {
  const { id, page } = usePage();
  const registry = useContext(RegistryContext);
  const queue = useQueue(id);
  // After every render: the comparison with what the server holds makes a redraw with the same text free. A closed
  // review takes no drafts, and its boxes are gone.
  useEffect(() => {
    if (queue !== undefined && page.writable)
      keep(registry, queue, id, slot, draft);
  });
};

/**
 * Sends a box's text through `action`, which empties the slot on the server. The slot's scheduled text is dropped and
 * saves already under way finish first, so none lands after the action. Text typed into the slot meanwhile, as in a
 * composer opened on other lines, is saved again once the action is done; a box whose action failed saves its text
 * again when it next draws.
 */
export const useSendDraft = (slot: DraftSlot) => {
  const { id } = usePage();
  const registry = useContext(RegistryContext);
  const queue = useQueue(id);
  const key = slotKey(slot);
  return useCallback(
    async <A>(action: () => Promise<Outcome<A>>): Promise<Outcome<A>> => {
      if (queue === undefined) return action();
      queue.forget(slot);
      setHeld(registry, id, key, undefined);
      await queue.flush();
      const outcome = await action();
      const typed = registry.get(heldAtom(id))?.get(key);
      if (outcome.ok && typed !== undefined) queue.schedule(typed);
      return outcome;
    },
    // The key stands for the slot.
    [queue, registry, id, key],
  );
};

/**
 * Keeps the line comment slot holding the open composer's text, on the lines it is open on. Text kept from a composer
 * whose code changed stays saved on its old lines until a composer takes it, so opening the review again offers it
 * again. Closing the composer, as Cancel and Esc do, empties the slot.
 */
export const useKeepComposer = (review: ReviewId) => {
  const registry = useContext(RegistryContext);
  const queue = useQueue(review);
  useEffect(() => {
    if (queue === undefined) return;
    const sync = () => {
      const drafts = registry.get(draftsAtom(review));
      const open = drafts.find((draft) => !draft.submitting);
      // A composer being sent leaves the slot to its action, which empties it; text kept from a composer whose code
      // changed stays saved where it was.
      const unchanged =
        (open === undefined && drafts.length > 0) ||
        registry.get(stashAtom(review)).trim() !== "";
      const draft: Draft | undefined =
        open !== undefined && open.body.trim() !== ""
          ? { kind: "comment", selection: open.selection, body: open.body }
          : unchanged
            ? registry.get(heldAtom(review))?.get(slotKey(COMMENT_SLOT))
            : undefined;
      keep(registry, queue, review, COMMENT_SLOT, draft);
    };
    sync();
    const stops = [
      registry.subscribe(draftsAtom(review), sync),
      registry.subscribe(stashAtom(review), sync),
      registry.subscribe(heldAtom(review), sync),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }, [registry, queue, review]);
};

/**
 * Puts a review's saved drafts back into its boxes, once per page: when the page first shows the review. Text the
 * page holds is never replaced, so coming back to a review, as a stack walkthrough does, keeps what was typed since.
 * `reveal` opens what folds a restored composer's lines, given the element ID of its last row or line.
 */
export const useRestoreDrafts = (
  review: ReviewId,
  page: PageModel | undefined,
  reveal?: (id: string) => unknown,
) => {
  const registry = useContext(RegistryContext);
  const shown = page !== undefined;
  useEffect(() => {
    if (page === undefined || registry.get(heldAtom(review)) !== undefined)
      return;
    const saved = page.snapshot.drafts;
    for (const item of restoring(
      saved,
      page.snapshot.state.comments,
      page.files,
    ))
      restore(registry, review, item, reveal);
    // Last, so the boxes the drafts went into find the server holding what they show.
    registry.set(
      heldAtom(review),
      new Map(saved.map(({ draft }) => [slotKey(slotOf(draft)), draft])),
    );
    // Once, when the review first shows: later snapshots' drafts are older than what the page holds.
  }, [registry, review, shown]);
};

const restore = (
  registry: AtomRegistry.AtomRegistry,
  review: ReviewId,
  item: Restored,
  reveal: ((id: string) => unknown) | undefined,
) => {
  switch (item.kind) {
    case "general": {
      const atom = generalDraftAtom(review);
      if (registry.get(atom) === "") registry.set(atom, item.body);
      return;
    }
    case "finish": {
      const atom = finishDraftAtom(review);
      const now = registry.get(atom);
      if (now.body === "" && now.verdict === "comment")
        registry.set(atom, { verdict: item.verdict, body: item.body });
      return;
    }
    case "reply":
    case "edit": {
      const atom = (item.kind === "reply" ? replyAtom : editAtom)({
        review,
        comment: item.comment,
      });
      if (registry.get(atom).body === "")
        registry.set(atom, { open: true, body: item.body });
      return;
    }
    case "comment": {
      const drafts = registry.get(draftsAtom(review));
      if (drafts.some((draft) => !draft.submitting)) return;
      registry.set(draftsAtom(review), [
        ...drafts,
        {
          id: Math.max(0, ...drafts.map((draft) => draft.id)) + 1,
          selection: item.selection,
          body: item.body,
          submitting: false,
          // No + button opened it: closing it focuses the one on its last row.
          opener: "",
          focusPending: false,
        },
      ]);
      reveal?.(item.element);
      return;
    }
    case "stash": {
      if (registry.get(stashAtom(review)) !== "") return;
      registry.set(stashAtom(review), item.body);
      toast(STASHED_TEXT, "danger");
      return;
    }
  }
};
