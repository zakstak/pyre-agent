/**
 * Where the drafts the server kept for a review go when the page opens it: each into its box, or, for a comment whose
 * code changed since, into the stash that fills the next comment. Pure, so tests need no browser; saving.ts puts them
 * there.
 */
import type { SavedDraft } from "../../schema/draft.ts";
import type { Comment, Verdict } from "../../schema/feedback.ts";
import type { CommentId, RepoPath } from "../../schema/primitives.ts";
import type { Selection } from "../../schema/selection.ts";
import { canEdit, isPending } from "../../review/queries.ts";
import { type FileVersion, onVersion } from "./diff-model.ts";

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
      readonly selection: Selection;
      readonly body: string;
      /** The element ID of the selection's last row or line, which the page reveals. */
      readonly element: string;
    }
  | { readonly kind: "stash"; readonly body: string };

/**
 * Where each saved draft goes back. A box with no text has nothing to restore. A reply or an edit needs its comment,
 * one that can still take it; a line comment needs the version of the file it was written on, the patch for rows and
 * the text for lines, and otherwise its text is offered for the next comment.
 */
export const restoring = (
  saved: ReadonlyArray<SavedDraft>,
  comments: ReadonlyArray<Comment>,
  files: ReadonlyMap<
    RepoPath,
    Pick<FileVersion, "digest" | "text"> & { readonly index: number }
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
        const file = files.get(selection.path);
        return file !== undefined && onVersion(selection, file)
          ? [
              {
                kind: "comment",
                selection,
                body: draft.body,
                element:
                  selection.kind === "rows"
                    ? `f${file.index}-r${selection.end_row}`
                    : `f${file.index}-l${selection.end_line}`,
              },
            ]
          : [{ kind: "stash", body: draft.body }];
      }
    }
  });
