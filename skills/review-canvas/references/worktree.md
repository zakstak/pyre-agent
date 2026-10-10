# Review a local working tree

A working tree review shows the uncommitted changes in a local Git repository: staged, unstaged, and untracked files that are not ignored, compared with `HEAD`. No PR, staging, or commit is needed first. The reviewer comments on exact old-side or new-side lines and approves exact file versions. The agent reads the exported feedback as structured data.

## The review loop

1. Finish the change, then run the collector. It writes a snapshot of every changed file with its patch and fingerprint.
2. Add analysis to the snapshot: groups, summaries, pseudocode, traces, and callouts. Keep every collector field as it is.
3. Render the page and give it to the reviewer.
4. The reviewer comments, approves files, and exports feedback. To continue an earlier round, the reviewer first imports the previous round's feedback into the new page.
5. Validate the feedback, then verify each quote against the patch in the snapshot it names. For each comment, fix the code, reject the comment with a reason, defer it with a blocker, or ask a question.
6. Collect and render the next round. Approvals carry over for every file whose fingerprint still matches. Changed files return to the queue. Comments reattach to the new patch or show as orphans.
7. Stop when the reviewer is satisfied. Report the approval counts and any open comments. Committing still needs the user's normal authorization.

## Run the collector

```sh
python3 /path/to/review-canvas/scripts/collect_worktree.py --repo /path/to/repo --output /private/review.json --title "Short change title"
```

| Option | Meaning |
| --- | --- |
| `--repo DIR` | Any path inside the working tree. Defaults to the current directory. |
| `-o`, `--output FILE` | Where to write the snapshot. It must be outside the working tree, or inside its Git directory. |
| `--title TEXT` | The review title. Defaults to `Uncommitted changes on BRANCH`. |
| `--include-secret-file PATH` | Show the contents of one likely secret file. Repeat for each file. |

The collector writes `schema_version` 2 input with a `worktree` target and `files_complete: true`. Every file starts in the `core` group. It writes the file with mode 0600 and prints a summary, including each likely secret file it left out. It exits with code 2 and writes nothing when it fails.

It needs a commit at `HEAD`. In a repository with no commits, it fails with a message.

## What the collector records

The collector runs Git with argument lists and literal pathspecs. It turns off external diff programs, text conversion, color, file system monitors, and index refreshes, and it never writes to the repository. It ignores `GIT_DIR` and other variables that would point Git at another repository. It does not run code from the repository.

| Change | Entry |
| --- | --- |
| Staged and unstaged edits | The patch from `HEAD` to the file on disk |
| Untracked file that is not ignored | Status `added`, with every line as an addition |
| File marked with `git add -N` | Status `added` |
| Staged rename | Status `renamed`, with `old_path`. An untracked new name and a deleted old name stay two entries. |
| Deletion | Status `deleted` |
| Mode-only change | Status `changed`, `old_mode` and `new_mode`, and `patch_note: "no_content_change"` |
| Binary file | No patch, `patch_note: "binary"` |
| Symbolic link | No patch, `patch_note: "symlink"` |
| Submodule whose checked-out commit changed, or untracked nested repository | No patch, `patch_note: "submodule"`. Uncommitted edits inside a submodule do not count. |
| Empty file | No patch, `patch_note: "empty"` |
| Patch over the input limits | No patch, `patch_note: "too_large"`, `patch_complete: false` |
| Non-UTF-8 bytes or control characters | The patch, with `patch_note: "replaced_characters"` |
| CRLF line endings | The patch, with `\r` kept at the end of each line |

Every entry keeps its path, status, and stats, even when it has no patch. A file whose timestamps changed but whose content and mode match `HEAD` is not a change.

## Fingerprints

A fingerprint identifies one exact version of one changed file. It is a SHA-256 digest over the path, the original path for a rename, the old blob ID and mode from `HEAD`, and the new blob ID and mode from the file on disk. The new blob ID is the Git blob ID of the bytes on disk, with no filters. A symbolic link uses its target. A submodule uses its checked-out commit.

A file stays approved while its fingerprint matches. Any change to its content, mode, or path makes it a new version.

The collector hashes bytes with no filters, so in a repository that uses clean filters or line-ending conversion, such as Git LFS or `core.autocrlf`, its fingerprints differ from the committed blob IDs. They still stay stable between rounds. Git itself still runs a configured clean filter while it compares the working tree, because it needs the filtered content to build the patch.

## Files that change during collection

The agent may still be writing files while the collector runs. After it builds the snapshot, the collector reads `HEAD` and every fingerprint again. If anything changed, it starts over. After 3 attempts, it fails and asks you to run it again when the writes finish.

## Likely secret files

Untracked files are more likely to hold secrets than a PR is, for example a stray `.env.local` that is not ignored. By default, the collector leaves out the contents of likely secret files. The entry and stats stay, with `patch_note: "secret"`. A file is a likely secret file when:

- its name is `.env` or starts with `.env.`, except names that end in `.example`, `.sample`, `.template`, or `.dist`
- its name ends in `.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.keystore`, or `.kdbx`
- its name is `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, `.netrc`, `_netrc`, `.npmrc`, `.pypirc`, `.git-credentials`, `.htpasswd`, `credentials`, or `credentials.json`
- its patch contains a private key block, or a token in a known format: AWS access key IDs, GitHub tokens, Slack tokens, and `sk-` API keys

The check applies to tracked and untracked files, and to the old path of a rename. Tell the reviewer which files the collector left out. To show one, pass `--include-secret-file PATH` after you confirm the file holds no secret. The redaction rule in `SKILL.md` still applies to every patch.

## Where to keep the files

Keep the snapshot, the rendered page, and the exported feedback in a private directory outside the working tree, so they never land in a commit.
