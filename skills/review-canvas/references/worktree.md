# Review a local working tree

A working tree review shows the uncommitted changes in a local Git repository:
staged, unstaged, and untracked files that are not ignored, compared with
`HEAD`. No PR, staging, or commit is needed first. The reviewer comments on
exact old-side or new-side lines and approves exact file versions.

## The review loop

1. Finish the change. Collect a snapshot of the working tree into the session
   folder. It holds every changed file with its patch, fingerprint, and text.
2. Write the analysis file: the summary, groups, file notes, and the tour. Keep
   the snapshot as the collector wrote it; `publish --analysis` merges the two.
3. Register the thread, dry-run and publish the round, and give the reviewer
   the URL.
4. The reviewer walks the tour, comments, approves files, and chooses **Finish
   review**. `review-canvas wait` returns with the verdict and the comments. A
   question the reviewer asks now returns `wait` at once; answer it and wait
   again.
5. Answer what needs no change: reject a comment with a reason, defer it with a
   blocker, ask a question, or explain.
6. Change the code for the rest, test it, and run `review-canvas check`, so the
   page shows which files changed since the round. Collect and publish the next
   round with the updated analysis file, then answer each fixed comment with
   its file's fingerprint from that round. Approvals carry over for every file
   whose fingerprint still matches. Changed files return to the queue, marked
   with their changes since the round before. Comments reattach to the new
   patch or show as orphans.
7. Stop when the reviewer is satisfied. Report the verdict, the approval
   counts, and any open comments. Committing still needs the user's normal
   authorization.

## Run the collector

```sh
"$RC" collect --repo /path/to/repo --output "$SESSION/round-1.json" --title "Short change title"
```

| Option                  | Meaning                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `--repo DIR`            | Any path inside the working tree.                                                                                    |
| `--output FILE`         | Where to write the snapshot: outside the repository. A path inside the working tree or the Git directory is refused. |
| `--title TEXT`          | The review title. Defaults to `Uncommitted changes on BRANCH`.                                                       |
| `--include-secret PATH` | Show the contents of one likely secret file, by exact repository-relative path. Repeat for each file.                |
| `--no-content`          | Leave out each file's whole text. Without it, the page can show the unchanged lines around each patch.               |

The collector writes `review-canvas.input/1` input with a `worktree` target and
`files_complete: true`. Every file starts in the `core` group with no analysis.
It writes the file with mode 0600, in a 0700 folder it creates when needed. It
prints a summary with each likely secret file it left out to stderr, and JSON
to stdout: the file count, the target, `flagged` (likely secret files left
out), and `staged` (files whose staged version differs from both `HEAD` and the
working tree, so a commit would record content the review does not show), and
`without_content` (text files whose whole text did not fit in the input, so
the page cannot open the unchanged lines around their patch). It exits
with code 1 and writes nothing when it fails.

It needs a commit at `HEAD`. It refuses a repository with unmerged paths, and a
path removed from the index but kept on disk, with a message that says what to
do.

## What the collector protects

It runs Git only from a trusted path, never one inside the repository, a bare
clone, or a `core.worktree` checkout. It switches off filters, external diffs,
text conversion, grafts, the shallow file, and inherited `GIT_*` variables,
and uses literal pathspecs, so nothing in the change under review runs. It
reads the inventory twice around one consistency check, so a snapshot never
mixes two states of the tree. It replaces hidden and reordering characters in
patches, and a file that looks like a secret, by name or by content, is listed
without its contents.

It reports a staged version that differs from both `HEAD` and the working
tree, because a commit would then record content the reviewer did not see.
