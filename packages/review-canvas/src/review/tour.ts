import type { ReviewFile, ReviewInput } from "../schema/input.ts";
import * as Limits from "../schema/limits.ts";
import type { RepoPath } from "../schema/primitives.ts";
import type { Attention, StopFile } from "../schema/tour.ts";
import { parseRows, rowsForLines } from "./patch.ts";

/** An excerpt resolved to rows of its file's patch. */
export interface ExcerptView {
  readonly path: RepoPath;
  readonly side: "old" | "new";
  readonly start_row: number;
  readonly end_row: number;
  readonly caption: string;
  /** Notes of the stop that fall in this excerpt, lettered A, B, C across the stop. */
  readonly notes: ReadonlyArray<NoteView>;
}

export interface NoteView {
  readonly letter: string;
  readonly row: number;
  readonly title: string;
  readonly body: string;
}

export interface StopView {
  readonly index: number;
  readonly title: string;
  readonly summary: string;
  readonly attention: Attention | null;
  readonly excerpts: ReadonlyArray<ExcerptView>;
  /** Files the stop covers: those with an excerpt, then those it lists without one. */
  readonly files: ReadonlyArray<StopFile>;
  readonly questions: ReadonlyArray<string>;
  /** True for the stop the server adds for files no stop covers. */
  readonly closing: boolean;
  /** The files this stop is the first to cover. */
  readonly owns: ReadonlyArray<RepoPath>;
}

export interface TourView {
  readonly stops: ReadonlyArray<StopView>;
  /** What the server left out of the agent's tour, for the agent to read. */
  readonly warnings: ReadonlyArray<string>;
}

const letter = (index: number) => String.fromCharCode(65 + (index % 26));

const CLOSING_TITLE = "Other files";

/**
 * Resolves a round's tour against its patches: excerpts become row ranges, clamped to the rows the patch shows and
 * to {@link Limits.MAX_EXCERPT_ROWS}; notes attach to a row of an excerpt of the same stop; a file is covered by the
 * first stop that excerpts or lists it. Files no stop covers go in one closing stop. A round with no tour gets only
 * that closing stop, so every review has a tour to walk.
 */
export const tourView = (input: ReviewInput): TourView => {
  const files = new Map<string, ReviewFile>(
    input.files.map((file) => [file.path, file]),
  );
  const rowsOf = new Map<string, ReturnType<typeof parseRows>>();
  const rows = (file: ReviewFile) => {
    let parsed = rowsOf.get(file.path);
    if (parsed === undefined) {
      parsed = parseRows(file.patch ?? "");
      rowsOf.set(file.path, parsed);
    }
    return parsed;
  };
  const warnings: Array<string> = [];
  const covered = new Set<string>();
  const stops: Array<StopView> = [];
  for (const [index, stop] of (input.stops ?? []).entries()) {
    const where = `stop ${index + 1} ("${stop.title}")`;
    const excerpts: Array<ExcerptView> = [];
    let letters = 0;
    const pendingNotes = [...stop.notes];
    const owns: Array<RepoPath> = [];
    for (const excerpt of stop.excerpts) {
      const file = files.get(excerpt.path);
      if (file === undefined) {
        warnings.push(
          `${where}: dropped an excerpt of ${excerpt.path}, which is not a changed file`,
        );
        continue;
      }
      if (file.patch === undefined) {
        warnings.push(
          `${where}: dropped an excerpt of ${excerpt.path}, which has no patch`,
        );
        continue;
      }
      const range = rowsForLines(
        rows(file),
        excerpt.side,
        excerpt.start,
        excerpt.end,
      );
      if (range === undefined) {
        warnings.push(
          `${where}: dropped an excerpt of ${excerpt.path} ${excerpt.side} lines ${excerpt.start}-${excerpt.end}, which the patch does not show`,
        );
        continue;
      }
      let end = range.end;
      if (end - range.start + 1 > Limits.MAX_EXCERPT_ROWS) {
        end = range.start + Limits.MAX_EXCERPT_ROWS - 1;
        warnings.push(
          `${where}: cut an excerpt of ${excerpt.path} to ${Limits.MAX_EXCERPT_ROWS} rows`,
        );
      }
      const notes: Array<NoteView> = [];
      for (let at = pendingNotes.length - 1; at >= 0; at--) {
        const note = pendingNotes[at];
        if (note === undefined || note.path !== excerpt.path) continue;
        const row = rows(file).find(
          (candidate) =>
            candidate.index >= range.start &&
            candidate.index <= end &&
            candidate[excerpt.side] === note.line,
        );
        if (row === undefined) continue;
        notes.push({
          letter: "",
          row: row.index,
          title: note.title,
          body: note.body,
        });
        pendingNotes.splice(at, 1);
      }
      notes.sort((a, b) => a.row - b.row);
      excerpts.push({
        path: excerpt.path,
        side: excerpt.side,
        start_row: range.start,
        end_row: end,
        caption: excerpt.caption,
        notes: notes.map((note) => ({ ...note, letter: letter(letters++) })),
      });
      if (!covered.has(excerpt.path)) owns.push(excerpt.path);
      covered.add(excerpt.path);
    }
    for (const note of pendingNotes)
      warnings.push(
        `${where}: dropped the note "${note.title}" on ${note.path} line ${note.line}, which no excerpt of the stop shows`,
      );
    const listed: Array<StopFile> = [];
    const excerpted = new Set<string>(excerpts.map((excerpt) => excerpt.path));
    for (const file of stop.files) {
      if (!files.has(file.path)) {
        warnings.push(
          `${where}: dropped the file ${file.path}, which is not a changed file`,
        );
        continue;
      }
      if (covered.has(file.path)) {
        // The stop that first excerpts or lists a file owns it; a later entry, and its note, are left out.
        if (excerpted.has(file.path)) {
          if (file.note !== undefined)
            warnings.push(
              `${where}: left out the note on ${file.path}, which this stop excerpts; put it in the excerpt's caption`,
            );
        } else {
          warnings.push(
            `${where}: left out ${file.path}, which an earlier stop already covers`,
          );
        }
        continue;
      }
      covered.add(file.path);
      owns.push(file.path);
      listed.push(file);
    }
    const shown = [...new Set(excerpts.map((excerpt) => excerpt.path))].map(
      (path): StopFile => ({ path }),
    );
    stops.push({
      index: stops.length,
      title: stop.title,
      summary: stop.summary,
      attention: stop.attention,
      excerpts,
      files: [...shown, ...listed],
      questions: stop.questions,
      closing: false,
      owns,
    });
  }
  const left = input.files
    .filter((file) => !covered.has(file.path))
    .map((file): StopFile => ({ path: file.path }));
  if (left.length > 0 && stops.length > 0) {
    const shown = left
      .slice(0, 5)
      .map((file) => file.path)
      .join(", ");
    warnings.push(
      `${left.length} file${left.length === 1 ? "" : "s"} no stop covers went into a closing "Other files" stop: ${shown}${left.length > 5 ? ", …" : ""}`,
    );
  }
  if (left.length > 0 || stops.length === 0) {
    stops.push({
      index: stops.length,
      title: stops.length === 0 ? "Changed files" : CLOSING_TITLE,
      summary:
        stops.length === 0
          ? "This round has no tour. Every changed file is listed here."
          : "Changed files the tour does not otherwise cover.",
      attention: null,
      excerpts: [],
      files: left,
      questions: [],
      closing: true,
      owns: left.map((file) => file.path),
    });
  }
  return { stops, warnings };
};
