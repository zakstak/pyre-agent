# Review a hosted pull request or merge request

A hosted review shows the request's changes as its host's changed-files page
shows them: each file's patch from the merge base, with its fingerprint and
whole new text. The reviewer comments on exact lines and approves exact file
versions, and `publish` brings the pull request's own comments onto the page.

## Run the collector

Collect from a local clone of the repository:

```sh
"$RC" collect --pr https://github.com/OWNER/REPO/pull/NUMBER --repo /path/to/clone --output "$SESSION/round-1.json"
```

It reads the request's title, commits, base branch, and file list through the
host's provider adapter, and everything else from the clone. GitHub and GitHub
Enterprise use `gh`; GitLab and Gitea/Forgejo use `curl` and the configured
HTTPS Git credential helper. Use existing authentication and verified HTTPS
trust. See
[private Git hosts](../../../packages/review-canvas/README.md#private-git-hosts).
The clone must hold both the base and the head commit. The command fetches
nothing: when one is missing, it fails, writes nothing, and prints the
`git fetch` command to run. Run it, then collect again. The secret checks and
the size limits are the same as for a working tree; see
[the working tree reference](worktree.md).

It prints JSON to stdout with the file count, the target, and:

- `flagged`: likely secret files, listed without their contents.
- `without_content`: text files whose whole text did not fit, so the page shows
  their patch without the unchanged lines around it. Mention them among the
  coverage limits.
- `files_complete`: true only when the clone's files match the host's list and
  count, and the head did not move during collection.
- `inventory_mismatch`: the paths only one side lists and both counts, when they
  differ. Rename detection can differ between Git and the host; say so in the
  summary.
- `head_moved`: true when the head moved during collection. Collect again, or
  say in the summary that the round may be behind.
- `base_ref`: the branch the pull request merges into.

## A layer of a stack

A pull request can be one layer of a stack: its `base_ref` is another pull
request's branch rather than the repository's default branch, or its description
names the other layers. Find the adjacent pull requests with your authorized
host tools, by their head and base branches. [The tour reference](tour.md) says
how to tour one layer.

## Later rounds

`review-canvas check --session "$SESSION"` compares the pull request's head with
the current round and lists `changed` paths and `head_moved`; pass `--head SHA`
when the host cannot read the head. Collect the next round from the clone after
fetching the new head. `fixed` answers name the fixing commit with
`--fixed-in-commit`.
