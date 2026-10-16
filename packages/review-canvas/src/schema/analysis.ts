/**
 * The agent's analysis of a change, kept apart from the collected snapshot. The collector writes a new snapshot each
 * round with every file in the core group and no analysis; the agent keeps one analysis file across rounds, edits
 * it, and `publish --analysis` merges it into the snapshot. Paths the round does not hold are reported, not applied.
 */
import * as Schema from "effect/Schema";
import { Callout, FileGroup, type ReviewInput, Trace } from "./input.ts";
import * as Limits from "./limits.ts";
import { text } from "./primitives.ts";
import { Tour } from "./tour.ts";

const Text = text(Limits.MAX_TEXT_UNITS);

export const FileAnalysis = Schema.Struct({
  group: Schema.optionalKey(FileGroup),
  summary: Schema.optionalKey(Text),
  pseudocode: Schema.optionalKey(Text),
  trace: Schema.optionalKey(Trace),
  callouts: Schema.optionalKey(
    Schema.Array(Callout).check(Schema.isMaxLength(Limits.MAX_CALLOUTS)),
  ),
});
export type FileAnalysis = typeof FileAnalysis.Type;

export const Analysis = Schema.Struct({
  /** The review's main point. */
  summary: Schema.optionalKey(Text),
  stops: Schema.optionalKey(Tour),
  /** By repository path. */
  files: Schema.optionalKey(Schema.Record(Schema.String, FileAnalysis)),
});
export type Analysis = typeof Analysis.Type;

/** The snapshot with the analysis applied, and the analysis paths the snapshot does not hold. */
export const applyAnalysis = (
  input: ReviewInput,
  analysis: Analysis,
): {
  readonly input: ReviewInput;
  readonly unknownPaths: ReadonlyArray<string>;
} => {
  const files = analysis.files ?? {};
  const known = new Set<string>(input.files.map((file) => file.path));
  return {
    input: {
      ...input,
      ...(analysis.summary === undefined ? {} : { summary: analysis.summary }),
      ...(analysis.stops === undefined ? {} : { stops: analysis.stops }),
      files: input.files.map((file) => ({ ...file, ...files[file.path] })),
    },
    unknownPaths: Object.keys(files).filter((path) => !known.has(path)),
  };
};
