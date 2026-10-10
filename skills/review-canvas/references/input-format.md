# Review input

The renderer accepts UTF-8 JSON with `schema_version: 2`, a `target` object, and a `files` array. It rejects unknown fields and invalid types rather than silently dropping data. All strings are plain text, including summaries and patches. HTML and Markdown are not interpreted.

Version 1 input, which had a `pr` object, fails with a message that names the version. There is no migration. Collect a new snapshot instead.

Use [example-review.json](../assets/example-review.json) as a working starting point. For a working tree, `scripts/collect_worktree.py` writes a valid skeleton; see [the working tree reference](worktree.md). Run each script with `--help` for its command-line options.

## Target

`target.kind` is `github_pr` or `worktree`. Both kinds require `title`.

| Kind | Required | Optional |
| --- | --- | --- |
| `github_pr` | `kind`, `title` | `url`, `head_sha`, `base_sha`, `changed_files` |
| `worktree` | `kind`, `title`, `root`, `head_sha` | `branch`, `changed_files` |

- `url`, when present, must identify a PR at `https://github.com/OWNER/REPO/pull/NUMBER`.
- `head_sha` and `base_sha` are full commit hashes. For a working tree, `head_sha` is the `HEAD` commit that the uncommitted changes are compared with.
- `root` is the absolute path of the working tree: a POSIX path, a Windows drive path, or a Windows UNC path such as `\\server\share\repo`. `branch` is the checked-out branch; omit it for a detached `HEAD`.
- `changed_files` records the expected file count.

Inline comments need a pinned target. A `github_pr` target is pinned only when it has both `url` and `head_sha`. A `worktree` target is always pinned.

## Coverage

The optional top-level `summary` explains the review's main point. `files_complete` describes whether the file inventory has been reconciled. `true` requires `target.changed_files` to equal the number of files. Leave it false if access, pagination, changing commits, or truncation prevents a complete snapshot. A complete file inventory does not establish complete patch coverage.

## Files

Each file requires:

- `path`: exact repository-relative changed-file path
- `status`: `added`, `modified`, `deleted`, `removed`, `renamed`, `copied`, `changed`, or `unchanged`
- `group`: `core`, `wiring`, or `mechanical`
- `additions` and `deletions`: non-negative integers

Each file in a `worktree` target also requires `fingerprint`. It is optional for a `github_pr` target.

- `fingerprint`: 64 lowercase hexadecimal characters that identify one exact version of the change to this file. An approval stores it, and the page treats the file as approved only while the fingerprint still matches. A file without a fingerprint cannot be approved. `scripts/fingerprint.py` computes it: SHA-256 over the path, the original path for a rename, the old and new Git blob IDs, and the old and new modes.
- `old_path`: the original path of a `renamed` or `copied` file
- `old_mode` and `new_mode`: six-digit octal Git modes such as `100644`. The page shows a mode change.

`patch` is a unified diff as plain text, starting at the first `@@` hunk header. Omit it or use null when unavailable. The page flags absent or empty patches. Set `patch_complete` to true only after verifying the entire patch, or false for truncated or redacted patches. An omitted flag means completeness is unverified and produces a warning. Do not mark a patch complete just because the API returned some text. CR characters are kept, so a CRLF line ends in `\r`.

`patch_note` names why a file has no patch, or why its patch differs from the bytes on disk. The renderer writes the notice text.

| `patch_note` | Patch | Meaning |
| --- | --- | --- |
| `binary` | none | A binary file |
| `too_large` | none | The patch exceeds the limits below |
| `symlink` | none | A symbolic link |
| `submodule` | none | A submodule or nested repository |
| `secret` | none | A likely secret file whose contents were left out |
| `no_content_change` | none | Only the path or mode changed |
| `empty` | none | An empty file |
| `replaced_characters` | required | Invalid UTF-8 bytes appear as U+FFFD, and control characters other than tab, LF, and CR appear as Unicode control pictures |

Optional analysis fields are:

- `summary`: a terse explanation of the change and its interactions
- `pseudocode`: a short algorithm description
- `trace`: an object with `input`, `before`, and `after` strings
- `callouts`: an array of objects with `tag` and `text` strings

The renderer groups files as core, wiring, and mechanical. Within a group, it keeps the order supplied by the agent. Every supplied file and available patch remains accessible.

Never include credentials, raw authorization responses, or secrets. The renderer validates structure and escapes content, but it cannot identify every secret in source code. Redaction and coverage claims are the agent's responsibility.

## Agent replies

The optional top-level `replies` array holds the agent's answers to feedback comments. The reviewer's answers live in feedback, so each file keeps one writer. Copy every earlier agent reply into each new round, because the page shows the replies of the round it renders. `scripts/reply.py carry` copies them, and `scripts/reply.py add` appends one validated reply.

A thread is ordered by `created_at`. A reply must sort after the reply it answers, even when the two machines' clocks differ, so `reply.py add` stamps each reply at least one millisecond after the newest reply already in its thread. `created_at` must be a real UTC time from year 1 on; February 31 and `24:00:00` are refused, because JavaScript and Python would order them differently.

`reply.py add` refuses an answer when it is not the agent's turn: after the reviewer accepts, or while an earlier answer waits for the reviewer. A `fixed` answer's fingerprint must belong to a file in the round. `reply.py carry` refuses a round from another review, and refuses when the new round already holds a different reply under the same ID.

Each reply requires:

- `comment_id`: the `id` of the feedback comment it answers
- `id`: a stable reply ID, unique in this input, of 1 to 80 letters, digits, hyphens, or underscores
- `actor`: `agent`
- `created_at`: the UTC time in ISO 8601, such as `2026-10-10T09:00:00Z`, optionally with milliseconds
- `body`: plain text
- `disposition`: `fixed`, `rejected`, `deferred`, or `question`

A `fixed` reply also requires `fixed_in`, either `{"fingerprint": "..."}` for the file version that fixes the comment or `{"commit": "..."}` with a full commit hash. A `deferred` reply also requires `blocker`, the reason the change waits. A `rejected` reply gives its reason in `body`. Other dispositions cannot carry `fixed_in` or `blocker`.

```json
{
  "comment_id": "3f0c2e9a-6c1d-4b8e-9a51-7d2f4c8b1e60",
  "id": "agent-reply-1",
  "actor": "agent",
  "created_at": "2026-10-10T10:00:00Z",
  "disposition": "fixed",
  "body": "save() now flushes and fsyncs the temporary file before the rename.",
  "fixed_in": { "fingerprint": "9c1d5e..." }
}
```

## Input limits

The generator rejects oversized input before producing an artifact. It never silently truncates it.

- UTF-8 JSON file: at most 32 MiB
- File inventory: at most 2,000 entries, with unique paths
- One patch: at most 4,194,304 UTF-16 code units and 10,000 LF-delimited lines
- All patches combined: at most 50,000 lines
- Paths and `root`: at most 4,096 UTF-16 code units
- Other text fields: at most 20,000 UTF-16 code units, except callout tags, which allow 100, and `branch`, which allows 1,024

Text limits count UTF-16 code units, as the page's JavaScript does, so an emoji counts as 2. Input the renderer accepts always fits the feedback the page saves.
- Callouts: at most 100 per file
- Agent replies: at most 5,000, with unique IDs
- Counts: integers from 0 through 1,000,000,000,000; booleans are not counts
- Commit SHAs: full hexadecimal hashes with 40 or 64 characters

Duplicate JSON keys, unknown fields, invalid types, unsupported control characters, and Unicode surrogates are rejected. Hunk line numbers up to 12 digits receive line annotations. Unsupported hunk formats remain visible as literal text.

If a change exceeds these limits, report the limit and the affected coverage. Agree on a narrower review or make explicitly labeled partial artifacts. Keep each available file entry and stats where possible, and label any omitted patch. Set `files_complete` to false for partial inventories and `patch_complete` to false for excerpts. Do not claim that a partial artifact covers the whole change.
