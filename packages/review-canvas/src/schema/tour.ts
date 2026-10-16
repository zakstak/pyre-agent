import * as Schema from "effect/Schema";
import * as Limits from "./limits.ts";
import { integer, nonEmptyText, RepoPath, text } from "./primitives.ts";

/**
 * A guided tour of the change: ordered stops the reviewer walks through, each showing a few excerpts of the diff with
 * the agent's explanation. The agent writes it as part of a round. The server clamps every excerpt and note to the
 * patches of the round, and adds a closing stop for files no stop shows, so a rendered tour covers every file.
 */

const Text = text(Limits.MAX_TEXT_UNITS);
const RequiredText = nonEmptyText(Limits.MAX_TEXT_UNITS);
const SourceLine = integer(1, Limits.MAX_LINE);

export const ATTENTION_KINDS = [
  "tradeoff",
  "contract",
  "product",
  "risk",
  "accessibility",
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

/** The one call at a stop that only the reviewer can make. Most stops have none. */
export const Attention = Schema.Struct({
  kind: Schema.Literals(ATTENTION_KINDS),
  note: RequiredText,
});
export type Attention = typeof Attention.Type;

const ExcerptFields = Schema.Struct({
  path: RepoPath,
  /** Which side's line numbers start and end name. Old-side excerpts show deleted lines. */
  side: Schema.Literals(["old", "new"]),
  start: SourceLine,
  end: SourceLine,
  caption: Text,
});

/** A few lines of one file's patch, named by source line numbers on one side. */
export const Excerpt = ExcerptFields.check(
  Schema.makeFilter(
    (excerpt: typeof ExcerptFields.Type) =>
      excerpt.end >= excerpt.start || {
        path: ["end"],
        issue: "must not come before start",
      },
  ),
);
export type Excerpt = typeof Excerpt.Type;

/** An explanation pinned to one line of an excerpt. It explains; it is not a finding. */
export const StopNote = Schema.Struct({
  path: RepoPath,
  line: SourceLine,
  title: nonEmptyText(Limits.MAX_LABEL_UNITS),
  body: Text,
});
export type StopNote = typeof StopNote.Type;

/** A file the stop covers without showing an excerpt of it. */
export const StopFile = Schema.Struct({
  path: RepoPath,
  note: Schema.optionalKey(Text),
});
export type StopFile = typeof StopFile.Type;

export const Stop = Schema.Struct({
  title: nonEmptyText(Limits.MAX_LABEL_UNITS),
  summary: Text,
  attention: Schema.NullOr(Attention),
  excerpts: Schema.Array(Excerpt).check(
    Schema.isMaxLength(Limits.MAX_EXCERPTS_PER_STOP),
  ),
  files: Schema.Array(StopFile).check(Schema.isMaxLength(Limits.MAX_FILES)),
  notes: Schema.Array(StopNote).check(
    Schema.isMaxLength(Limits.MAX_NOTES_PER_STOP),
  ),
  questions: Schema.Array(RequiredText).check(
    Schema.isMaxLength(Limits.MAX_QUESTIONS_PER_STOP),
  ),
});
export type Stop = typeof Stop.Type;

export const Tour = Schema.Array(Stop).check(
  Schema.isMaxLength(Limits.MAX_STOPS),
);
export type Tour = typeof Tour.Type;
