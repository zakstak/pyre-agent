/**
 * Where the drafts the server kept for a review go when the page opens it: each into its box, or, for a comment whose
 * code changed since, into the stash that fills the next comment. Pure, so tests need no browser; saving.ts puts them
 * there.
 */
import type { SavedDraft } from "../../schema/draft.ts";
import type { Comment, Verdict } from "../../schema/feedback.ts";
import type {
  CommentId,
  PatchDigest,
  RepoPath,
} from "../../schema/primitives.ts";
import { canEdit, isPending } from "../../review/queries.ts";

/** A saved draft as it goes back into the page: into a box, or, for a comment whose code changed, into the stash. */
export type Restored =
  | { readonly kind: "general"; readonly body: string }
  | {
      readonly kind: "finish";
      readonly verdict: Verdict;
      readonly body: string;
    }
  | {
      readonly kind: "reply" | "edit";
      readonly comment: CommentId;
      readonly body: string;
    }
  | {
      readonly kind: "comment";
      readonly path: RepoPath;
      readonly digest: PatchDigest;
      readonly start: number;
      readonly end: number;
      readonly body: string;
      /** The file's place in the round, which names the element of its last row. */
      readonly index: number;
    }
  | { readonly kind: "stash"; readonly body: string };

/**
 * Where each saved draft goes back. A box with no text has nothing to restore. A reply or an edit needs its comment,
 * one that can still take it; a line comment needs the patch it was written on, and otherwise its text is offered
 * for the next comment. Lines of a file's text cannot hold a composer yet, so their text is offered the same way.
 */
export const restoring = (
  saved: ReadonlyArray<SavedDraft>,
  comments: ReadonlyArray<Comment>,
  files: ReadonlyMap<
    RepoPath,
    { readonly index: number; readonly digest: PatchDigest | undefined }
  >,
): ReadonlyArray<Restored> =>
  saved.flatMap(({ draft }): ReadonlyArray<Restored> => {
    switch (draft.kind) {
      case "general":
        return draft.body === "" ? [] : [draft];
      case "finish":
        return draft.body === "" && draft.verdict === "comment" ? [] : [draft];
      case "reply":
      case "edit": {
        const comment = comments.find((item) => item.id === draft.comment);
        const fits =
          comment !== undefined &&
          (draft.kind === "edit" ? canEdit(comment) : !isPending(comment));
        return fits && draft.body !== "" ? [draft] : [];
      }
      case "comment": {
        if (draft.body.trim() === "") return [];
        const { selection } = draft;
        const file =
          selection.kind === "rows" ? files.get(selection.path) : undefined;
        return selection.kind === "rows" &&
          file !== undefined &&
          file.digest === selection.patch_sha256
          ? [
              {
                kind: "comment",
                path: selection.path,
                digest: selection.patch_sha256,
                start: selection.start_row,
                end: selection.end_row,
                body: draft.body,
                index: file.index,
              },
            ]
          : [{ kind: "stash", body: draft.body }];
      }
    }
  });
