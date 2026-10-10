# Review input

The renderer accepts UTF-8 JSON with `schema_version: 1`, a `pr` object, and a `files` array. It rejects unknown fields and invalid types rather than silently dropping data. All strings are plain text, including summaries and patches. HTML and Markdown are not interpreted.

Use [example-review.json](../assets/example-review.json) as a working starting point. Run the generator with `--help` for its command-line options.

## PR and coverage

`pr.title` is required. `pr.url`, when present, must identify a PR at `https://github.com/OWNER/REPO/pull/NUMBER`. Use `pr.head_sha` and `pr.base_sha` to identify the snapshot, and `pr.changed_files` to record the expected file count.

The optional top-level `summary` explains the review's main point. `files_complete` describes whether the file inventory has been reconciled. Leave it false if access, pagination, changing commits, or truncation prevents a complete snapshot. A complete file inventory does not establish complete patch coverage.

## Files

Each file requires:

- `path`: exact repository-relative changed-file path
- `status`: `added`, `modified`, `deleted`, `removed`, `renamed`, `copied`, `changed`, or `unchanged`
- `group`: `core`, `wiring`, or `mechanical`
- `additions` and `deletions`: non-negative integers

`patch` is a unified diff as plain text. Omit it or use null when unavailable. The page flags absent or empty patches. Set `patch_complete` to true only after verifying the entire patch, or false for truncated or redacted patches. An omitted flag means completeness is unverified and produces a warning. Do not mark a patch complete just because the API returned some text.

Optional analysis fields are:

- `summary`: a terse explanation of the change and its interactions
- `pseudocode`: a short algorithm description
- `trace`: an object with `input`, `before`, and `after` strings
- `callouts`: an array of objects with `tag` and `text` strings

The renderer groups files as core, wiring, and mechanical. Within a group, it keeps the order supplied by the agent. Every supplied file and available patch remains accessible.

Never include credentials, raw authorization responses, or secrets. The renderer validates structure and escapes content, but it cannot identify every secret in source code. Redaction and coverage claims are the agent's responsibility.

## Input limits

The generator rejects oversized input before producing an artifact. It never silently truncates it.

- UTF-8 JSON file: at most 32 MiB
- File inventory: at most 2,000 entries, with unique paths
- One patch: at most 4,194,304 characters and 10,000 LF-delimited lines
- All patches combined: at most 50,000 lines
- Paths: at most 4,096 characters
- Other text fields: at most 20,000 characters, except callout tags, which allow 100
- Callouts: at most 100 per file
- Counts: integers from 0 through 1,000,000,000,000; booleans are not counts
- Commit SHAs: full hexadecimal hashes with 40 or 64 characters

Duplicate JSON keys, unknown fields, invalid types, unsupported control characters, and Unicode surrogates are rejected. Hunk line numbers up to 12 digits receive line annotations. Unsupported hunk formats remain visible as literal text.

If a PR exceeds these limits, report the limit and the affected coverage. Agree on a narrower review or make explicitly labeled partial artifacts. Keep each available file entry and stats where possible, and label any omitted patch. Set `files_complete` to false for partial inventories and `patch_complete` to false for excerpts. Do not claim that a partial artifact covers the whole PR.
