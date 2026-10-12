# Review a local working tree

A working tree review shows the uncommitted changes in a local Git repository:
staged, unstaged, and untracked files that are not ignored, compared with
`HEAD`. No PR, staging, or commit is needed first. The reviewer comments on
exact old-side or new-side lines and approves exact file versions.

## The review loop

1. Finish the change. Collect a snapshot of the working tree into the session
   folder. It holds every changed file with its patch and fingerprint.
2. Add analysis to the snapshot: the summary, groups, file notes, and the tour.
   Keep every collector field as it is.
3. Register the thread, publish the round, and give the reviewer the URL.
4. The reviewer walks the tour, comments, approves files, and chooses **Finish
   review**. `review-canvas wait` returns with the verdict and the comments.
5. For each comment, fix the code, reject the comment with a reason, defer it
   with a blocker, or ask a question, and answer it.
6. When the code changed, collect and publish the next round. Approvals carry
   over for every file whose fingerprint still matches. Changed files return to
   the queue. Comments reattach to the new patch or show as orphans.
7. Stop when the reviewer is satisfied. Report the verdict, the approval
   counts, and any open comments. Committing still needs the user's normal
   authorization.

## Run the collector

```sh
review-canvas collect --repo /path/to/repo --output "$SESSION/round-1.json" --title "Short change title"
```

| Option                  | Meaning                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `--repo DIR`            | Any path inside the working tree.                                                                                    |
| `--output FILE`         | Where to write the snapshot: outside the repository. A path inside the working tree or the Git directory is refused. |
| `--title TEXT`          | The review title. Defaults to `Uncommitted changes on BRANCH`.                                                       |
| `--include-secret PATH` | Show the contents of one likely secret file, by exact repository-relative path. Repeat for each file.                |

The collector writes `review-canvas.input/1` input with a `worktree` target and
`files_complete: true`. Every file starts in the `core` group with no analysis.
It writes the file with mode 0600, prints a summary with each likely secret
file it left out, and prints JSON with the file count and the target. It exits
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
