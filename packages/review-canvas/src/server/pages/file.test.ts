import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReviewFile } from "../../schema/input.ts";
import { fileBlock, type FilePage, type FileView } from "./file.ts";
import { shortPath } from "./names.ts";

const patch = "@@ -1,1 +1,1 @@\n-one\n+one!\n";

const view = (file: Readonly<Record<string, unknown>>, extra: Partial<FileView> = {}): FileView => ({
  index: 0,
  file: {
    path: "src/a.ts",
    status: "modified",
    group: "core",
    additions: 1,
    deletions: 1,
    patch,
    new_content: "one!\n",
    fingerprint: "f1",
    ...file,
  } as ReviewFile,
  approved: false,
  lapsed: false,
  placed: [],
  orphans: [],
  open: 0,
  forYou: 0,
  unchangedSince: undefined,
  previous: undefined,
  caption: undefined,
  shown: undefined,
  notes: [],
  folded: false,
  held: false,
  ...extra,
});

const page: FilePage = { threads: [], standing: () => "resolved", writable: true, layout: "unified", round: 2 };

const header = (v: FileView) => {
  const markup = fileBlock(v, page).value;
  return markup.slice(markup.indexOf("<header"), markup.indexOf("</header>"));
};

const previous = { path: "src/a.ts", status: "modified", group: "core", additions: 0, deletions: 0, new_content: "one\n" } as ReviewFile;

test("a file header shows one status word: a lapsed approval, then a change since the round before, then what the file is", () => {
  const lapsed = header(view({}, { lapsed: true, previous }));
  assert.match(lapsed, /class="file-word warning" data-extra aria-expanded="false" aria-controls="since-f0">changed since you viewed it</);
  assert.doesNotMatch(lapsed, /changed since round/);

  const changed = header(view({ status: "added" }, { previous }));
  assert.match(changed, /aria-controls="since-f0">changed since round 1</);
  assert.doesNotMatch(changed, /file-status/);

  assert.match(header(view({ status: "renamed", old_path: "src/b.ts" })), /<span class="file-status">renamed from src\/b.ts</);
  // Modified, and unchanged since the round before, say nothing.
  assert.doesNotMatch(header(view({})), /file-status|file-word/);
  assert.doesNotMatch(header(view({}, { unchangedSince: 1, previous: { ...previous, new_content: "one!\n" } })), /file-status|file-word|unchanged/);
});

test("a file header leads with a chevron that names the fold, and never says Hide diff or Show diff", () => {
  const open = header(view({}));
  assert.match(open, /^<header class="file-head">\n<button type="button" class="fold-toggle" data-fold aria-controls="body-f0" aria-expanded="true" aria-label="Hide diff"><svg/);
  assert.match(header(view({}, { folded: true })), /aria-expanded="false" aria-label="Show diff"/);
  assert.doesNotMatch(open.replace(/aria-label="[^"]*"/g, ""), /Hide diff|Show diff/);
});

test("a sidebar name is the last folder and the file name, whole", () => {
  assert.equal(
    shortPath("src/jobs/webhook-retry-queue.ts").value,
    '<span class="dir">jobs/</span><span class="base">webhook-retry-queue.ts</span>',
  );
  assert.equal(shortPath("pnpm-lock.yaml").value, '<span class="base">pnpm-lock.yaml</span>');
});
