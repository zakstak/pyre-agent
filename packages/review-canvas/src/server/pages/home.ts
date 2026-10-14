/**
 * The home page: the reviews, with what each needs from the reviewer, then the monitored repositories with their
 * checkouts and reviews, the repositories found but not monitored, and the scan form.
 */
import { existsSync } from "node:fs";
import type { ReviewSummary } from "../../store/store.ts";
import type { WorktreeRoot } from "../../schema/primitives.ts";
import { repositoryId, type Repository } from "../../schema/repositories.ts";
import { remoteAddress, repositoryName, type Discovery, type RepositoryStatus } from "../repositories.ts";
import type { Assets } from "../assets.ts";
import { type Html, html } from "../html.ts";
import { page, themeControl } from "./layout.ts";
import { count, homePath, targetName, targetText, threadLabel, time } from "./names.ts";
import { VERDICT_TEXT } from "./review.ts";

/** Whose move a review waits for, which its dot shows. */
type Standing = "yours" | "agents" | "closed";

const standing = (item: ReviewSummary): Standing =>
  item.closed_at !== undefined
    ? "closed"
    : item.for_you > 0 || (item.round !== undefined && !item.submitted)
      ? "yours"
      : "agents";

/** The one thing a review needs, in bold at the right of its row; the action colour when it is the reviewer's. */
const needs = (item: ReviewSummary): { readonly text: string; readonly yours: boolean } | undefined => {
  if (item.closed_at !== undefined) return undefined;
  if (item.round === undefined) return { text: "Waiting for the first round", yours: false };
  if (item.for_you > 0) return { text: `${count(item.for_you, "answer")} to read`, yours: true };
  if (item.verdict !== undefined) return { text: `Round ${item.round} finished · ${VERDICT_TEXT[item.verdict]}`, yours: false };
  if (item.drift !== undefined) return { text: `${count(item.drift, "file")} changed since the round`, yours: true };
  const left = (item.round_files ?? 0) - (item.viewed ?? 0);
  return left > 0
    ? { text: `${count(left, "file")} to review`, yours: true }
    : { text: `Finish round ${item.round}`, yours: true };
};

const reviewRow = (item: ReviewSummary): Html => {
  const state = standing(item);
  const need = needs(item);
  return html`<li class="review-row ${state}" data-review-row data-standing="${state}">
<span class="status-dot ${state}" role="img" aria-label="${state === "yours" ? "Needs you" : state === "agents" ? "Waiting on agents" : "Closed"}"></span>
<div class="row-main">
<a class="row-title" href="/reviews/${item.id}">${item.target.title}</a>
<p class="row-meta">${targetText(item.target)}${item.threads.length === 0 ? "" : html` <span>${item.threads.map((thread, at) => html`${at === 0 ? "" : ", "}${threadLabel(thread)}`)}</span>`}${item.closed_at !== undefined ? html` <span>closed · replaced by a fresh start</span>` : item.round === undefined ? "" : html` <span>Round ${item.round}</span>`}</p>
</div>
<div class="row-side">
${need === undefined ? "" : html`<p class="row-need${need.yours ? " yours" : ""}">${need.text}</p>`}
<p class="row-when">${item.round === undefined || item.closed_at !== undefined ? "" : html`${item.viewed ?? 0} of ${item.round_files ?? 0} viewed · `}${item.closed_at !== undefined ? time(item.closed_at) : item.published_at === undefined ? html`started ${time(item.created_at)}` : time(item.published_at)}</p>
</div>
</li>`;
};

const reviewsSection = (reviews: ReadonlyArray<ReviewSummary>): Html => {
  // Those that need the reviewer first, then those waiting on agents, closed last; newest first within each.
  const order: Readonly<Record<Standing, number>> = { yours: 0, agents: 1, closed: 2 };
  const sorted = [...reviews].sort((a, b) => order[standing(a)] - order[standing(b)]);
  const tally = { yours: 0, agents: 0, closed: 0 };
  for (const item of reviews) tally[standing(item)]++;
  const summary = [
    ...(tally.yours === 0 ? [] : [`${tally.yours} need${tally.yours === 1 ? "s" : ""} you`]),
    ...(tally.agents === 0 ? [] : [`${tally.agents} waiting on agents`]),
    ...(tally.closed === 0 ? [] : [`${tally.closed} closed`]),
  ].join(" · ");
  return html`<section class="home-section" aria-labelledby="reviews-title">
<div class="section-head"><h2 id="reviews-title">Reviews</h2>${summary === "" ? "" : html`<span class="muted">${summary}</span>`}</div>
${
  reviews.length === 0
    ? html`<p class="muted">No reviews yet. An agent starts one with <code>review-canvas register</code>.</p>`
    : html`<ul class="rows">${sorted.map(reviewRow)}</ul>`
}
</section>`;
};

interface RepositoryHome {
  readonly discovery: Discovery;
  readonly monitored: ReadonlyArray<{ readonly repository: Repository; readonly checkouts: ReadonlyArray<{ readonly root: WorktreeRoot; readonly status: RepositoryStatus }> }>;
  readonly selectedRoot: string;
  readonly query: string;
  readonly filter: string;
}

/** A repository's name and where it lives: `acme/ledger` on `github.com`, or a local name with no remote. */
const repositoryParts = (repository: Repository): { readonly name: string; readonly host: string } => {
  if (repository.identity.kind !== "remote") return { name: repositoryName(repository), host: "no remote" };
  const address = repository.identity.address;
  const at = address.indexOf("/");
  return at === -1 ? { name: address, host: "" } : { name: address.slice(at + 1), host: address.slice(0, at) };
};

/** A checkout's state in a few words, coloured only when it needs a look. */
const checkoutState = (root: string, status: RepositoryStatus | undefined): Html => {
  if (status === undefined) return html``;
  if (status.kind === "unavailable") {
    const why = /different repository/.test(status.message)
      ? "another repository"
      : existsSync(root)
        ? "status unreadable"
        : "directory missing";
    return html`<span class="checkout-state danger" title="${status.message}">unavailable · ${why}</span>`;
  }
  const branch = status.branch ?? "detached";
  return status.changed > 0
    ? html`<span class="checkout-state warning">${branch} · ${status.changed} changed</span>`
    : html`<span class="checkout-state">${branch} · clean</span>`;
};

const reviewLink = (item: ReviewSummary): Html => {
  const name = targetName(item.target);
  return html`<li data-repository-review><a href="/reviews/${item.id}">${item.target.title}</a> <span class="muted">${name.kind === "pr" ? `${name.number} · ` : ""}${item.closed_at !== undefined ? "closed" : item.round === undefined ? "waiting" : `round ${item.round}`}</span></li>`;
};

const repositoryRow = (
  repository: Repository,
  statuses: ReadonlyArray<{ readonly root: WorktreeRoot; readonly status: RepositoryStatus }> | undefined,
  reviews: ReadonlyArray<ReviewSummary>,
): Html => {
  const { name, host } = repositoryParts(repository);
  const full = repositoryName(repository);
  const pullRequests = reviews.filter((item) => item.target.kind === "github_pr" &&
    repository.identity.kind === "remote" &&
    remoteAddress(item.target.url.replace(/\/pull\/[0-9]+$/, "")) === repository.identity.address);
  const states = statuses === undefined ? ["discovered"] : statuses.map(({ status }) => status.kind === "ready" ? status.changed > 0 ? "changed" : "clean" : "unavailable");
  const search = `${full} ${repository.checkouts.join(" ")} ${statuses?.map(({ status }) => status.kind === "ready" ? status.branch ?? "detached" : "").join(" ") ?? ""}`.toLowerCase();
  const monitored = statuses !== undefined;
  return html`<li class="repository" data-repository data-monitoring="${monitored ? "monitored" : "discovered"}" data-status="${[...new Set(states)].join(" ")}" data-search="${search}">
<div class="repository-head">
<h3 class="repository-name" title="${full}">${name}</h3>${host === "" ? "" : html`<code class="repository-host">${host}</code>`}
<button type="button" class="${monitored ? "small-button quiet" : "small-button"}" data-repository-action="${monitored ? "remove" : "accept"}" data-id="${repositoryId(repository.identity)}" data-root="${repository.checkouts[0]}" aria-label="${monitored ? "Remove" : "Monitor"} ${full}" disabled>${monitored ? "Remove" : "Monitor"}</button>
</div>
<ul class="checkouts">${repository.checkouts.map((root) => {
    const worktrees = reviews.filter((item) => item.target.kind === "worktree" && item.target.root === root);
    return html`<li data-checkout><div class="checkout-line"><code class="checkout-path" title="${root}">${homePath(root)}</code>${checkoutState(root, statuses?.find((item) => item.root === root)?.status)}</div>${worktrees.length === 0 ? "" : html`<ul class="row-reviews">${worktrees.map(reviewLink)}</ul>`}</li>`;
  })}</ul>
${pullRequests.length === 0 ? "" : html`<ul class="row-reviews" aria-label="Pull request reviews">${pullRequests.map(reviewLink)}</ul>`}
</li>`;
};

const repositories = (view: RepositoryHome, reviews: ReadonlyArray<ReviewSummary>): Html => {
  const accepted = new Set(view.monitored.map((item) => repositoryId(item.repository.identity)));
  const discovered = view.discovery.repositories.filter((repository) => !accepted.has(repositoryId(repository.identity)));
  const checkouts = view.monitored.reduce((sum, item) => sum + item.repository.checkouts.length, 0);
  const none = view.monitored.length + discovered.length === 0;
  const roots = view.discovery.roots.map(homePath);
  return html`<section class="home-section" aria-labelledby="repositories-title" data-repositories>
<div class="section-head"><h2 id="repositories-title">Repositories</h2><span class="muted"><span>${view.monitored.length} monitored</span> · <span>${count(checkouts, "checkout")}</span></span>
<label class="search"><span class="sr-only">Filter repositories</span><input type="search" data-repository-search placeholder="Filter by name, path, or branch" value="${view.query}" data-filter="${view.filter}"></label></div>
<p class="sr-only" data-repository-count role="status"></p>
<p class="repository-error" role="alert" data-repository-error hidden></p>
<p class="muted" data-repository-empty hidden>No repositories match this filter.</p>
${none ? html`<p class="muted">No repositories found. Scan a directory below.</p>` : ""}
${view.monitored.length === 0 ? (none ? "" : html`<p class="muted">None monitored yet. Monitor one of those found below.</p>`) : html`<ul class="rows" aria-label="Monitored repositories">${view.monitored.map(({ repository, checkouts: statuses }) => repositoryRow(repository, statuses, reviews))}</ul>`}
${discovered.length === 0 ? "" : html`<div class="section-head found-head"><h2 id="found-title">Found, not monitored</h2><span class="muted">${discovered.length}</span></div>
<ul class="rows" aria-labelledby="found-title">${discovered.map((repository) => repositoryRow(repository, undefined, reviews))}</ul>`}
<noscript><p class="muted">Enable JavaScript to monitor repositories and filter this list.</p></noscript>
<details class="scan"${none ? html` open` : ""}><summary>Scan directories${roots.length === 0 ? "" : html` · <code>${roots.join(", ")}</code>`}</summary><div class="scan-body">
<form method="get" action="/" class="repository-scan"><label class="field">Directory<input type="text" name="root" placeholder="Absolute directory path" value="${view.selectedRoot}"></label><input type="hidden" name="q" value="${view.query}"><input type="hidden" name="filter" value="${view.filter === "all" ? "" : view.filter}"><button type="submit">Scan</button></form>
<p class="small muted">Leave the directory empty to use the server's scan directories. Scans stop at repository roots, skip symlinks and hidden directories, and descend up to four levels.</p>
${view.discovery.warnings.length > 0 ? html`<ul class="small muted">${view.discovery.warnings.map((warning) => html`<li>${warning}</li>`)}</ul>` : ""}
</div></details>
</section>`;
};

export const homePage = (
  assets: Assets["Service"],
  reviews: ReadonlyArray<ReviewSummary>,
  repositoryView: RepositoryHome,
): Html =>
  page(assets, {
    title: "Review canvas",
    bodyClass: "home",
    topbar: html`<p class="brand"><strong>Review canvas</strong> <span class="muted">localhost · ${count(repositoryView.monitored.length, "repository", "repositories")} monitored</span></p><div class="topbar-actions"><button type="button" class="small-button quiet" data-repository-refresh disabled>Rescan</button></div>`,
    body: html`<main id="main" class="home-main" tabindex="-1">
${reviewsSection(reviews)}
${repositories(repositoryView, reviews)}
</main>
<footer class="foot home-foot small muted">${themeControl}</footer>`,
  });
