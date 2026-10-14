/** How the pages name things: threads, targets, paths, counts, and times. */
import { homedir } from "node:os";
import type { Target } from "../../schema/target.ts";
import type { Thread } from "../../schema/thread.ts";
import { type Html, html } from "../html.ts";

/**
 * A thread's name as a person says it: the label's part before a colon, so "Claude Code: webhook retry" is
 * "Claude Code". The full label stays available as a title.
 */
export const threadName = (label: string): string => {
  const at = label.indexOf(": ");
  return at > 0 ? label.slice(0, at) : label;
};

export const threadNameOf = (
  threads: ReadonlyArray<Thread>,
  id: string,
): string => threadName(threads.find((thread) => thread.id === id)?.label ?? id);

/** A thread's name, with its full label as the title when they differ. */
export const threadLabel = (thread: Thread): Html => {
  const name = threadName(thread.label);
  return name === thread.label
    ? html`<span>${name}</span>`
    : html`<span title="${thread.label}">${name}</span>`;
};

/** "1 file", "2 files". */
export const count = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

/** A time the page script shows on the reader's clock; without the script, UTC. */
export const time = (at: string): Html =>
  html`<time datetime="${at}" title="${at}">${at.slice(0, 16).replace("T", " ")} UTC</time>`;

/** The parts of a target the pages show: `acme/ledger #412`, or a checkout's name and branch. */
export type TargetName =
  | {
      readonly kind: "pr";
      readonly repository: string;
      readonly number: string;
      readonly url: string;
    }
  | {
      readonly kind: "worktree";
      readonly checkout: string;
      readonly branch: string | undefined;
      readonly root: string;
    };

export const targetName = (target: Target): TargetName => {
  if (target.kind === "github_pr") {
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([0-9]+)/.exec(
      target.url,
    );
    return {
      kind: "pr",
      repository: match?.[1] ?? target.url,
      number: match?.[2] === undefined ? "" : `#${match[2]}`,
      url: target.url,
    };
  }
  const parts = target.root.split("/").filter((part) => part !== "");
  return {
    kind: "worktree",
    checkout: parts.at(-1) ?? target.root,
    branch: target.branch,
    root: target.root,
  };
};

/** A target in one line of mono text: `acme/ledger #412`, or `ledger-webhooks · feat/x`. */
export const targetText = (target: Target): Html => {
  const name = targetName(target);
  return name.kind === "pr"
    ? html`<code class="target">${name.repository} <span class="muted">${name.number}</span></code>`
    : html`<code class="target" title="${name.root}">${name.checkout}${name.branch === undefined ? html` <span class="muted">· detached</span>` : html` <span class="muted">·</span> ${name.branch}`}</code>`;
};

/** A path with its folder muted and its file name plain. */
export const pathParts = (path: string): Html => {
  const at = path.lastIndexOf("/");
  return at === -1
    ? html`<span class="base">${path}</span>`
    : html`<span class="dir">${path.slice(0, at + 1)}</span><span class="base">${path.slice(at + 1)}</span>`;
};

/**
 * A path for a narrow list: the last folder and the file name. When the row is too narrow, the folder gives way
 * first, then the middle of the name, so its start and its extension stay readable.
 */
export const shortPath = (path: string): Html => {
  const parts = path.split("/");
  const base = parts.at(-1) ?? path;
  const folder = parts.at(-2);
  const dot = base.lastIndexOf(".");
  const split = Math.max(0, (dot > 0 ? dot : base.length) - 4);
  const name = html`<span class="base"><span class="stem">${base.slice(0, split)}</span><span class="tail">${base.slice(split)}</span></span>`;
  return folder === undefined ? name : html`<span class="dir">${folder}/</span>${name}`;
};

const home = homedir();

/** A local path with the home folder as `~`. */
export const homePath = (path: string): string =>
  home !== "" && home !== "/" && (path === home || path.startsWith(`${home}/`))
    ? `~${path.slice(home.length)}`
    : path;
