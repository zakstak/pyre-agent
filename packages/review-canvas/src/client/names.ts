/** How the pages name things: threads, targets, paths, and counts. */
import type { Verdict } from "../schema/feedback.ts";
import type { Target } from "../schema/target.ts";
import type { Thread } from "../schema/thread.ts";
import { parsePullRequest } from "../schema/forge-url.ts";

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

/**
 * Line numbers as the pages write them: "12" or "12–14", after `noun` when there is one, which takes an "s" for a
 * range: "line 12", "Lines 12–14". A location such as `path:12–14` has no noun.
 */
export const lineRange = (first: number, last: number, noun?: string): string => {
  const numbers = first === last ? `${first}` : `${first}–${last}`;
  return noun === undefined ? numbers : `${first === last ? noun : `${noun}s`} ${numbers}`;
};

/** The parts of a target the pages show: `acme/ledger #412`, or a checkout's name and branch. */
export type TargetName =
  | { readonly kind: "pr"; readonly repository: string; readonly number: string; readonly url: string }
  | { readonly kind: "worktree"; readonly checkout: string; readonly branch: string | undefined; readonly root: string };

export const targetName = (target: Target): TargetName => {
  if (target.kind !== "worktree") {
    const pull = parsePullRequest(target.url);
    return {
      kind: "pr",
      repository: pull === undefined ? target.url : `${pull.host === "github.com" ? "" : `${pull.host}/`}${pull.repository}`,
      number: pull === undefined ? "" : `${pull.provider === "gitlab" ? "!" : "#"}${pull.number}`,
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

/** A path below the longest of `roots` that holds it, else the path as it is. */
export const underRoot = (path: string, roots: ReadonlyArray<string>): string => {
  const root = roots
    .map((candidate) => candidate.replace(/\/+$/, ""))
    .filter((candidate) => path.startsWith(`${candidate}/`))
    .reduce<string | undefined>((longest, candidate) => (longest === undefined || candidate.length > longest.length ? candidate : longest), undefined);
  return root === undefined ? path : path.slice(root.length + 1);
};

/** A verdict as the strip and the home page say it. */
export const VERDICT_TEXT: Readonly<Record<Verdict, string>> = {
  approve: "approve",
  request_changes: "request changes",
  comment: "comment only",
};

/** What the reviewer did, in the past tense, after "you" or "You". */
export const VERDICT_DONE: Readonly<Record<Verdict, string>> = {
  approve: "approved",
  request_changes: "requested changes",
  comment: "commented",
};
