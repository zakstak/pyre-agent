/** How the pages name things: threads, targets, paths, and counts. */
import type { Verdict } from "../schema/feedback.ts";
import type { Target } from "../schema/target.ts";
import type { Thread } from "../schema/thread.ts";

/**
 * A thread's name as a person says it: the label's part before a colon, so "Claude Code: webhook retry" is
 * "Claude Code". The full label stays available as a title.
 */
export const threadName = (label: string): string => {
  const at = label.indexOf(": ");
  return at > 0 ? label.slice(0, at) : label;
};

export const threadNameOf = (threads: ReadonlyArray<Thread>, id: string): string =>
  threadName(threads.find((thread) => thread.id === id)?.label ?? id);

/** "1 file", "2 files". */
export const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The parts of a target the pages show: `acme/ledger #412`, or a checkout's name and branch. */
export type TargetName =
  | { readonly kind: "pr"; readonly repository: string; readonly number: string; readonly url: string }
  | { readonly kind: "worktree"; readonly checkout: string; readonly branch: string | undefined; readonly root: string };

export const targetName = (target: Target): TargetName => {
  if (target.kind === "github_pr") {
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([0-9]+)/.exec(target.url);
    return {
      kind: "pr",
      repository: match?.[1] ?? target.url,
      number: match?.[2] === undefined ? "" : `#${match[2]}`,
      url: target.url,
    };
  }
  const parts = target.root.split("/").filter((part) => part !== "");
  return { kind: "worktree", checkout: parts.at(-1) ?? target.root, branch: target.branch, root: target.root };
};

/** A path split into its folder, with the trailing slash, and its file name. */
export const splitPath = (path: string): { readonly dir: string; readonly base: string } => {
  const at = path.lastIndexOf("/");
  return at === -1 ? { dir: "", base: path } : { dir: path.slice(0, at + 1), base: path.slice(at + 1) };
};

/** The last folder of a path and its file name, for a narrow list. */
export const shortPath = (path: string): { readonly dir: string; readonly base: string } => {
  const parts = path.split("/");
  const folder = parts.at(-2);
  return { dir: folder === undefined ? "" : `${folder}/`, base: parts.at(-1) ?? path };
};

/** A verdict as the strip and the home page say it. */
export const VERDICT_TEXT: Readonly<Record<Verdict, string>> = {
  approve: "approve",
  request_changes: "request changes",
  comment: "comment only",
};

/** What the reviewer did, in the past tense. */
export const VERDICT_DONE: Readonly<Record<Verdict, string>> = {
  approve: "you approved",
  request_changes: "you requested changes",
  comment: "you commented",
};
