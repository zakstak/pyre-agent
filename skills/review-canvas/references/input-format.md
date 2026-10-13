# Review input

A round's input is UTF-8 JSON with `"format": "review-canvas.input/1"`, a
`target`, `files`, `files_complete`, and optionally a `summary` and `stops`. The
server rejects unknown fields and invalid types rather than dropping data. All
strings are plain text; HTML and Markdown are not interpreted. The page keeps
the line breaks in the agent's prose: summaries, attention notes, captions, note
bodies, callouts, and questions. One exception: in that prose, text between two
backticks on one line, such as `` `fsync()` ``, shows as code. The schema is
`src/schema/input.ts` and `src/schema/tour.ts` in
[packages/review-canvas](../../../packages/review-canvas/README.md).

`review-canvas collect` writes a valid input with every file in the `core`
group and no analysis: for a working tree, see
[the working tree reference](worktree.md); for a PR, `collect --pr`, from a
local clone that holds the PR's base and head commits.

## Target

`target.kind` is `github_pr` or `worktree`. Both require `title`.

| Kind        | Required                            | Optional                    |
| ----------- | ----------------------------------- | --------------------------- |
| `github_pr` | `kind`, `title`, `url`, `head_sha`  | `base_sha`, `changed_files` |
| `worktree`  | `kind`, `title`, `root`, `head_sha` | `branch`, `changed_files`   |

- `url` identifies a PR at `https://github.com/OWNER/REPO/pull/NUMBER`.
- `head_sha` and `base_sha` are full commit hashes. For a working tree,
  `head_sha` is the `HEAD` commit the uncommitted changes are compared with.
- `root` is the working tree's absolute POSIX path, as
  `git rev-parse --show-toplevel` prints it. `branch` is the checked-out
  branch; omit it for a detached `HEAD`.
- `changed_files` records the expected file count.

The target keys the review: every thread that registers for the same PR URL or
the same working tree root joins the same open review.

## Coverage

The optional top-level `summary` explains the review's main point, in a few
sentences. `files_complete` says whether the file inventory was reconciled;
`true` requires `target.changed_files` to equal the number of files. Leave it
false if access, pagination, changing commits, or truncation prevents a
complete snapshot. A complete inventory does not establish complete patch
coverage.

## Files

Each file requires:

- `path`: the exact repository-relative path
- `status`: `added`, `modified`, `deleted`, `removed`, `renamed`, `copied`,
  `changed`, or `unchanged`
- `group`: `core`, `wiring`, or `mechanical`
- `additions` and `deletions`: non-negative integers

Each file in a `worktree` target also requires `fingerprint`, 64 lowercase
hexadecimal characters that identify one exact version of the change to the
file. It is optional for a `github_pr` target; a file without one cannot be
approved.

Optional fields:

- `old_path`: required for a renamed or copied file, the path it came from
- `old_mode` and `new_mode`: six-digit octal Git modes
- `patch`: the unified diff from its first hunk header, as text. Omit it when
  there is none; `patch_note` then says why: `binary`, `too_large`, `symlink`,
  `submodule`, `secret`, `no_content_change`, or `empty`. A patch whose hidden
  characters were replaced carries `patch_note: "replaced_characters"`.
- `patch_complete`: `true` only after the whole patch was verified: it is whole
  hunks, and its lines add up to `additions` and `deletions`. `false` marks an
  excerpt. Absent means unverified.
- `new_content`: the file's whole text after the change, at most 1 MiB, so the
  page can show the unchanged lines around the patch on demand. Every context
  and added row of the patch must be the line of this text it names, or the
  server refuses the input. The collector includes it for each text file while
  half of the input limit has room after every patch.
- `summary`: what the change to this file does and why
- `pseudocode`: the algorithm, for dense logic
- `trace`: `{ "input", "before", "after" }`, one input through the old and new
  paths, for surprising behavior
- `callouts`: `[{ "tag", "text" }]`, each a genuine concern such as a race or a
  breaking change

Never include credentials, raw authorization responses, or secrets. The server
validates structure and escapes content, but it cannot identify every secret in
source code. Redaction and coverage claims are the agent's responsibility.

## Stops: the tour

`stops` is an ordered array. Each stop:

```json
{
  "title": "save() becomes atomic",
  "summary": "The store writes a temporary file beside the target and renames it over the old one. A crash during the write leaves the old notes intact.",
  "attention": { "kind": "risk", "note": "os.replace is atomic only within one filesystem." },
  "excerpts": [{ "path": "src/notes/store.py", "side": "new", "start": 11, "end": 17, "caption": "The new save path" }],
  "files": [{ "path": "src/notes/cli.py", "note": "Imports the new module." }],
  "notes": [{ "path": "src/notes/store.py", "line": 13, "title": "Same directory", "body": "mkstemp in the target's directory keeps the rename on one filesystem." }],
  "questions": ["Should a failed write remove the temporary file?"]
}
```

Every key is required: `null` for no attention, `[]` for no excerpts, files,
notes, or questions, and `""` for an empty summary, caption, or note body. The
limits below are the server's hard limits; the skill's numbers are how a good
tour reads.

- `title`: at most 200 UTF-16 units. `summary`: text, may be empty.
- `attention`: `null`, or `kind` of `tradeoff`, `contract`, `product`, `risk`,
  or `accessibility` with a `note`.
- `excerpts`: at most 10. `side` is `new` or `old`; `start` and `end` are
  source line numbers on that side, inclusive; an added file's new side is its
  own line numbers. The server resolves them to the rows the patch shows, from
  the first named line it shows to the last, with any hunk header between. It
  cuts an excerpt past 60 rows, and drops one that names no shown line or a
  file that is not in the round, with a warning that `publish` prints.
  `review-canvas hunks` prints each file's hunks as line ranges.
- `files`: files the stop covers without an excerpt, each with an optional
  `note`. The first stop that excerpts or lists a file owns it. A later stop's
  `files` entry for it is left out, and so is the note of an entry for a file
  the same stop excerpts; `publish` warns about each. Excerpts always show, in
  any stop. On the page, each stop lists the files it excerpts or owns, and
  opens their whole patch on demand.
- `notes`: at most 10. Each attaches to the row of one of the stop's excerpts
  that shows `line` on the excerpt's side. The page letters them A, B, C across
  the stop. A note that no excerpt shows is dropped with a warning.
- `questions`: at most 5 short questions. A click puts one in the reviewer's
  question box, ready to ask.

At most 50 stops. Files no stop covers go in a closing stop titled "Other
files" that the server adds, and `publish` warns about them. A round without
`stops` gets one stop, "Changed files", that lists every file.

## The analysis file

`publish --analysis FILE` merges an analysis file into the snapshot before it
publishes, so the agent keeps its analysis apart from the collected snapshot
and carries it from round to round:

```json
{
  "summary": "save() becomes atomic; the rest is a rename and a CLI hook.",
  "stops": [],
  "files": {
    "src/notes/store.py": { "summary": "Writes a temporary file and renames it." },
    "src/notes/cli.py": { "group": "wiring" }
  }
}
```

Each key is optional. `summary` and `stops` replace the snapshot's; each entry
of `files` sets the named fields of the file at that path: `group`, `summary`,
`pseudocode`, `trace`, and `callouts`. A path the round does not hold is
reported as a warning, not applied.

## Input limits

The server rejects oversized input and never truncates it.

- UTF-8 JSON: at most 32 MiB, as written
- Files: at most 2,000, with unique paths
- One patch: at most 4,194,304 UTF-16 units and 10,000 LF-delimited lines
- All patches combined: at most 50,000 lines
- Paths and `root`: at most 4,096 units; all paths together must leave feedback,
  which lists each path twice, under 6 MiB before comments
- Other text: at most 20,000 units, except callout tags and stop titles, which
  allow 100 and 200, and `branch`, which allows 1,024
- Callouts: at most 100 per file

Text limits count UTF-16 code units, so an emoji counts as 2. Duplicate JSON
keys, unknown fields, numbers with a fraction or exponent, control characters
other than tab, LF, and CR, and unpaired surrogates are rejected.

If a change exceeds these limits, report the limit and the affected coverage.
Agree on a narrower review, or label partial rounds: set `files_complete` to
false for a partial inventory and `patch_complete` to false for an excerpt. Do
not claim that a partial round covers the whole change.
