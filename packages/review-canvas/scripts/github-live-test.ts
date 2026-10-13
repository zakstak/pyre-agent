/**
 * Imports a real pull request's comments, read with the signed-in gh, into a review of that pull request built from a
 * local clone, and checks them against what GitHub shows: the schemas accept every comment, every thread is
 * imported, and every thread GitHub calls current attaches on the line GitHub shows it on. Outdated threads are
 * counted, attached or not. It only reads from GitHub. CI does not run it: it needs gh signed in, and the pull
 * request's base and head commits in the clone.
 *
 * Run: pnpm test:github https://github.com/OWNER/REPO/pull/NUMBER [CLONE]
 */
import assert from "node:assert/strict";
import * as Result from "effect/Result";
import { readComments, runGh } from "../src/cli/github.ts";
import { openWorktree } from "../src/collector/collect.ts";
import { attachedRows } from "../src/review/anchor.ts";
import { parseRows } from "../src/review/patch.ts";
import { decodeBytes, InputDocument } from "../src/schema/document.ts";
import { Store } from "../src/store/store.ts";

const [url, clone = process.cwd()] = process.argv.slice(2);
const pull = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([0-9]+)$/.exec(
  url ?? "",
);
assert.ok(
  url !== undefined && pull !== null,
  "usage: pnpm test:github https://github.com/OWNER/REPO/pull/NUMBER [CLONE]",
);

const { headRefOid: head, baseRefOid: base } = JSON.parse(
  runGh(["pr", "view", url, "--json", "headRefOid,baseRefOid"]),
) as { headRefOid: string; baseRefOid: string };

const worktree = openWorktree({ repo: clone });
const git = (...args: ReadonlyArray<string>) =>
  worktree.git
    .run(worktree.top, [...worktree.config, ...args])
    .toString("utf8");
for (const commit of [head, base])
  try {
    git("cat-file", "-e", `${commit}^{commit}`);
  } catch {
    assert.fail(
      `${commit} is not in ${worktree.top}; fetch it first: git fetch origin pull/${pull[3]}/head`,
    );
  }

// The round as an agent would write it: each file's patch from the merge base, as GitHub shows the pull request.
const from = git("merge-base", base, head).trim();
const STATUSES: Record<string, string> = {
  A: "added",
  C: "copied",
  D: "removed",
  M: "modified",
  R: "renamed",
  T: "changed",
};
const files = git("diff", "--name-status", "-z", "-M", from, head)
  .split("\0")
  .filter((field) => field !== "")
  .reduce<Array<Array<string>>>((entries, field) => {
    const last = entries.at(-1);
    const wanted = /^[RC]/.test(last?.[0] ?? "") ? 3 : 2;
    if (last === undefined || last.length === wanted) entries.push([field]);
    else last.push(field);
    return entries;
  }, [])
  .map(([status = "", ...paths]) => {
    const path = paths.at(-1) ?? "";
    const raw = git("diff", "-M", "-U3", from, head, "--", ...paths);
    const at = raw.indexOf("\n@@");
    const patch = at === -1 ? undefined : raw.slice(at + 1);
    const rows = (patch ?? "").split("\n");
    const kind = status[0] ?? "M";
    return {
      path,
      ...(paths.length === 2 ? { old_path: paths[0] } : {}),
      status: STATUSES[kind] ?? "modified",
      group: "core",
      additions: rows.filter((row) => row.startsWith("+")).length,
      deletions: rows.filter((row) => row.startsWith("-")).length,
      ...(patch === undefined ? { patch_note: "binary" } : { patch }),
    };
  });
const decoded = decodeBytes(
  InputDocument,
  Buffer.from(
    JSON.stringify({
      format: "review-canvas.input/1",
      target: {
        kind: "github_pr",
        title: `Live import of ${url}`,
        url,
        head_sha: head,
        base_sha: from,
        changed_files: files.length,
      },
      files_complete: true,
      files,
    }),
  ),
);
if (Result.isFailure(decoded))
  assert.fail(`the round is not valid input: ${decoded.failure.message}`);
const input = decoded.success;

// The comments as publish reads them, then imported as the server imports them.
const read = readComments(url, runGh);
const store = Store.open(":memory:");
const { review, thread } = store.register({
  target: input.target,
  label: "live test",
  host: { kind: "claude-code" },
});
const id = review.state.id;
store.publish(id, thread.id, input);
const { report } = store.importGitHub(
  id,
  read.pull_request,
  read.items,
  read.head_sha,
);
const comments = store.review(id)?.state.comments ?? [];
store.close();

// What GitHub shows each thread as, read separately from the import.
interface Shown {
  readonly isOutdated: boolean;
  readonly line: number | null;
  readonly diffSide: "LEFT" | "RIGHT";
  readonly comments: { readonly nodes: ReadonlyArray<{ readonly id: string }> };
}
const shown: Array<Shown> = [];
let after: string | null = null;
do {
  const page: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<Shown>;
  } = (
    JSON.parse(
      runGh([
        "api",
        "graphql",
        "-f",
        `query=query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviewThreads(first: 50, after: $after) { pageInfo { hasNextPage endCursor }
      nodes { isOutdated line diffSide comments(first: 1) { nodes { id } } } }
  } }
}`,
        "-F",
        `owner=${pull[1]}`,
        "-F",
        `name=${pull[2]}`,
        "-F",
        `number=${pull[3]}`,
        ...(after === null ? [] : ["-f", `after=${after}`]),
      ]),
    ) as {
      data: { repository: { pullRequest: { reviewThreads: typeof page } } };
    }
  ).data.repository.pullRequest.reviewThreads;
  shown.push(...page.nodes);
  after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
} while (after !== null);

const patches = new Map(input.files.map((file) => [file.path, file.patch]));
const tally: Record<string, number> = {};
const wrong: Array<string> = [];
for (const node of shown) {
  const first = node.comments.nodes[0];
  if (first === undefined) continue;
  const comment = comments.find(
    (item) => item.source.kind === "github" && item.source.id === first.id,
  );
  if (comment === undefined || comment.kind !== "inline") {
    wrong.push(`${first.id}: not imported as an inline comment`);
    continue;
  }
  const state = comment.attachment.state;
  if (node.isOutdated) {
    tally[`outdated, ${state}`] = (tally[`outdated, ${state}`] ?? 0) + 1;
    continue;
  }
  const rows = parseRows(patches.get(comment.anchor.path) ?? "");
  const span = attachedRows(rows, comment.attachment);
  const side = node.diffSide === "LEFT" ? "old" : "new";
  const line = span === undefined ? undefined : rows[span.end]?.[side];
  if (line === node.line)
    tally[`current, ${comment.attachment.reason}`] =
      (tally[`current, ${comment.attachment.reason}`] ?? 0) + 1;
  else
    wrong.push(
      `${comment.source.kind === "github" ? comment.source.url : comment.id}: GitHub shows it on line ${node.line}, the review ${line === undefined ? `left it ${state}` : `on line ${line}`}`,
    );
}

console.log(
  JSON.stringify(
    { pull_request: url, head, files: files.length, report, threads: tally },
    null,
    2,
  ),
);
assert.equal(read.head_sha, head, "the threads were read across a push");
assert.deepEqual(report.skipped, []);
assert.deepEqual(wrong, []);
console.log(`ok: ${shown.length} threads match what GitHub shows`);
