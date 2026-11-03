/**
 * Text the reviewer has written but not sent, which the server keeps so a reload, a restart, or another browser
 * finds it again. Drafts are the reviewer's alone: no agent reads them, and saving one changes nothing in the review.
 */
import * as Schema from "effect/Schema";
import { VERDICTS } from "./feedback.ts";
import * as Limits from "./limits.ts";
import { CommentId, text, Timestamp } from "./primitives.ts";
import { Selection } from "./selection.ts";

const Body = text(Limits.MAX_TEXT_UNITS);

/**
 * Where a draft is written: the one line comment composer, a reply box or an edit box under a comment, the comment
 * on the whole change, or the finish summary. A review holds at most one draft in each slot.
 */
export const DraftSlot = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("comment") }),
  Schema.Struct({ kind: Schema.Literal("reply"), comment: CommentId }),
  Schema.Struct({ kind: Schema.Literal("edit"), comment: CommentId }),
  Schema.Struct({ kind: Schema.Literal("general") }),
  Schema.Struct({ kind: Schema.Literal("finish") }),
]).annotate({
  expected:
    "a draft slot whose kind is comment, reply, edit, general, or finish",
});
export type DraftSlot = typeof DraftSlot.Type;

/**
 * A draft: its slot and the text in it. A line comment draft keeps the selection it was opened on, even after a new
 * round changes those lines, so the page can offer its text again on other lines.
 */
export const Draft = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("comment"),
    selection: Selection,
    body: Body,
  }),
  Schema.Struct({
    kind: Schema.Literal("reply"),
    comment: CommentId,
    body: Body,
  }),
  Schema.Struct({
    kind: Schema.Literal("edit"),
    comment: CommentId,
    body: Body,
  }),
  Schema.Struct({ kind: Schema.Literal("general"), body: Body }),
  Schema.Struct({
    kind: Schema.Literal("finish"),
    verdict: Schema.Literals(VERDICTS),
    body: Body,
  }),
]).annotate({
  expected: "a draft whose kind is comment, reply, edit, general, or finish",
});
export type Draft = typeof Draft.Type;

/** A draft as the server keeps it, with when it was last saved. */
export const SavedDraft = Schema.Struct({
  draft: Draft,
  saved_at: Timestamp,
});
export type SavedDraft = typeof SavedDraft.Type;

/** A change to what a slot holds: a draft saved in it, or the slot emptied. */
export const DraftWrite = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("save"), draft: Draft }),
  Schema.Struct({ kind: Schema.Literal("discard"), slot: DraftSlot }),
]).annotate({ expected: "a draft write whose kind is save or discard" });
export type DraftWrite = typeof DraftWrite.Type;

/**
 * The writes a page sends in one request that outlives it, as when it is hidden or closed: the newest unsent write of
 * each slot, so at most one for each slot a review can have.
 */
export const DraftWrites = Schema.Struct({
  writes: Schema.Array(DraftWrite).check(
    Schema.isMaxLength(3 + 2 * Limits.MAX_COMMENTS),
  ),
});
export type DraftWrites = typeof DraftWrites.Type;

/** The slot a draft fills. */
export const slotOf = (draft: Draft): DraftSlot => {
  switch (draft.kind) {
    case "comment":
    case "general":
    case "finish":
      return { kind: draft.kind };
    case "reply":
    case "edit":
      return { kind: draft.kind, comment: draft.comment };
  }
};

/** The slot a write changes. */
export const slotOfWrite = (write: DraftWrite): DraftSlot =>
  write.kind === "save" ? slotOf(write.draft) : write.slot;

/** The one key of a slot, by which the store and the page keep a draft: `comment`, `reply:ID`, `edit:ID`, ... */
export const slotKey = (slot: DraftSlot): string => {
  switch (slot.kind) {
    case "comment":
    case "general":
    case "finish":
      return slot.kind;
    case "reply":
    case "edit":
      return `${slot.kind}:${slot.comment}`;
  }
};

const hasKind = <K extends Draft["kind"]>(
  draft: Draft,
  kind: K,
): draft is Extract<Draft, { readonly kind: K }> => draft.kind === kind;

/** The saved draft in a slot, if any. */
export const draftIn = <K extends Draft["kind"]>(
  drafts: ReadonlyArray<SavedDraft>,
  slot: Extract<DraftSlot, { readonly kind: K }>,
): Extract<Draft, { readonly kind: K }> | undefined => {
  const key = slotKey(slot);
  for (const { draft } of drafts)
    if (hasKind(draft, slot.kind) && slotKey(slotOf(draft)) === key)
      return draft;
  return undefined;
};
