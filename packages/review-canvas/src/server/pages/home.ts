import type { Target } from "../../schema/target.ts";
import type { ReviewSummary } from "../../store/store.ts";
import type { WorktreeRoot } from "../../schema/primitives.ts";
import { repositoryId, type Repository } from "../../schema/repositories.ts";
import { remoteAddress, repositoryName, type Discovery, type RepositoryStatus } from "../repositories.ts";
import type { Assets } from "../assets.ts";
import { type Html, html } from "../html.ts";
import { time } from "./comments.ts";
import { page, themeToggle } from "./layout.ts";

export const targetLine = (target: Target): Html =>
  target.kind === "github_pr"
    ? html`<a href="${target.url}" rel="noopener">${target.url.replace("https://github.com/", "")}</a> <span class="muted">at <code>${target.head_sha.slice(0, 12)}</code></span>`
    : html`<code>${target.root}</code> <span class="muted">${target.branch === undefined ? "detached" : html`on <code>${target.branch}</code>`} at <code>${target.head_sha.slice(0, 12)}</code></span>`;

const review = (
  item: ReviewSummary,
): Html => html`<li class="panel review-card${item.closed_at === undefined ? "" : " closed"}">
<div class="panel-body stack">
<h2><a href="/reviews/${item.id}">${item.target.title}</a></h2>
<p class="small">${targetLine(item.target)}</p>
<p class="cluster small">
${item.closed_at === undefined ? "" : html`<span class="chip">Closed</span>`}
${item.round === undefined ? html`<span class="chip">Waiting for the first round</span>` : html`<span class="chip">Round ${item.round}</span>`}
${item.open_comments > 0 ? html`<span class="chip warning">${item.open_comments} open comment${item.open_comments === 1 ? "" : "s"}</span>` : ""}
${item.round !== undefined && item.submitted ? html`<span class="chip success">Finished</span>` : ""}
<span class="muted">${item.threads.map((thread) => thread.label).join(" · ")}</span>
<span class="muted">Started ${time(item.created_at)}</span>
</p>
</div>
</li>`;

interface RepositoryHome {
  readonly discovery: Discovery;
  readonly monitored: ReadonlyArray<{ readonly repository: Repository; readonly checkouts: ReadonlyArray<{ readonly root: WorktreeRoot; readonly status: RepositoryStatus }> }>;
  readonly selectedRoot: string;
  readonly query: string;
  readonly filter: string;
}

const checkout = (root: WorktreeRoot, status: RepositoryStatus | undefined, reviews: ReadonlyArray<ReviewSummary>): Html => {
  const matching = reviews.filter((item) => item.target.kind === "worktree" && item.target.root === root);
  return html`<li class="stack checkout" data-checkout>
<p class="repository-path"><code>${root}</code></p>
<p class="cluster small">
${status?.kind === "ready" ? html`<span class="chip">${status.branch === null ? "Detached HEAD" : status.branch}</span><span class="chip${status.changed > 0 ? " warning" : ""}">${status.changed > 0 ? `${status.changed} changed item${status.changed === 1 ? "" : "s"}` : "Clean"}</span>` : status?.kind === "unavailable" ? html`<span class="chip warning">Unavailable</span>` : ""}
${matching.map((item) => html`<a href="/reviews/${item.id}">${item.target.title}</a>`)}
</p>
${status?.kind === "unavailable" ? html`<p class="small muted">${status.message}</p>` : ""}
</li>`;
};

const repositoryCard = (repository: Repository, statuses: ReadonlyArray<{ readonly root: WorktreeRoot; readonly status: RepositoryStatus }> | undefined, reviews: ReadonlyArray<ReviewSummary>): Html => {
  const name = repositoryName(repository);
  const pullRequests = reviews.filter((item) => item.target.kind === "github_pr" &&
    repository.identity.kind === "remote" &&
    remoteAddress(item.target.url.replace(/\/pull\/[0-9]+$/, "")) === repository.identity.address);
  const states = statuses === undefined ? ["discovered"] : statuses.map(({ status }) => status.kind === "ready" ? status.changed > 0 ? "changed" : "clean" : "unavailable");
  const search = `${name} ${repository.checkouts.join(" ")} ${statuses?.map(({ status }) => status.kind === "ready" ? status.branch ?? "detached" : "").join(" ") ?? ""}`.toLowerCase();
  return html`<li class="panel repository-card" data-repository data-monitoring="${statuses === undefined ? "discovered" : "monitored"}" data-status="${[...new Set(states)].join(" ")}" data-search="${search}">
<div class="panel-body stack">
<div class="repository-body">
<div class="stack repository-info"><h3>${name}</h3><p class="cluster small"><span class="chip">${statuses === undefined ? "Discovered" : "Monitored"}</span><span class="chip">${repository.checkouts.length} checkout${repository.checkouts.length === 1 ? "" : "s"}</span>${statuses === undefined ? html`<span class="muted">Awaiting your acceptance</span>` : ""}</p></div>
<button type="button" data-repository-action="${statuses === undefined ? "accept" : "remove"}" data-id="${repositoryId(repository.identity)}" data-root="${repository.checkouts[0]}" aria-label="${statuses === undefined ? "Add to monitoring" : "Remove from monitoring"} ${name}" disabled>${statuses === undefined ? "Add to monitoring" : "Remove"}</button>
</div>
${pullRequests.length === 0 ? "" : html`<ul class="review-list stack small" aria-label="Pull request reviews">${pullRequests.map((item) => html`<li data-repository-review><a href="/reviews/${item.id}">${item.target.title}</a> <span class="muted">${item.round === undefined ? "Waiting for the first round" : `Round ${item.round}`}</span>${item.closed_at === undefined ? "" : html` <span class="chip">Closed</span>`}${item.submitted ? html` <span class="chip success">Finished</span>` : ""}</li>`)}</ul>`}
<details class="repository-copies"${repository.checkouts.length === 1 ? html` open` : ""}><summary>Checkouts</summary><ul class="review-list stack">${repository.checkouts.map((root) => checkout(root, statuses?.find((item) => item.root === root)?.status, reviews))}</ul></details>
</div></li>`;
};

const repositories = (view: RepositoryHome, reviews: ReadonlyArray<ReviewSummary>): Html => {
  const accepted = new Set(view.monitored.map((item) => repositoryId(item.repository.identity)));
  const discovered = view.discovery.repositories.filter((repository) => !accepted.has(repositoryId(repository.identity)));
  const copies = [...view.monitored.map((item) => item.repository), ...discovered].reduce((count, repository) => count + repository.checkouts.length, 0);
  return html`<section aria-labelledby="repositories-title" class="stack" data-repositories>
<div class="cluster repository-heading"><h1 id="repositories-title">Repositories</h1><span class="chip">${view.monitored.length} monitored</span><span class="chip">${discovered.length} discovered</span><span class="chip">${copies} checkouts</span></div>
<p class="muted">Choose repositories to monitor across their discovered checkouts. Discovery does not accept new repositories.</p>
<div class="repository-filters">
<label>Filter repositories<input type="search" data-repository-search placeholder="Name, path, or branch" value="${view.query}"></label>
<div class="repository-field"><label for="repository-filter">Show repositories</label><select id="repository-filter" data-repository-filter data-initial="${view.filter}"><option value="all">All repositories</option><option value="monitored">Monitored</option><option value="discovered">Discovered</option><option value="changed">With changes</option><option value="unavailable">Unavailable</option></select></div>
</div>
<p class="small muted" data-repository-count role="status"></p>
<p role="alert" data-repository-error hidden></p>
<p class="muted" data-repository-empty hidden>No repositories match these filters.</p>
${view.monitored.length + discovered.length === 0 ? html`<p class="muted">No repositories found. Choose a directory below to scan.</p>` : ""}
<ul class="review-list stack">${view.monitored.map(({ repository, checkouts }) => repositoryCard(repository, checkouts, reviews))}${discovered.map((repository) => repositoryCard(repository, undefined, reviews))}</ul>
<p class="small muted">Repository status is checked when you open or refresh this page.</p>
<noscript><p>Enable JavaScript to accept repositories and filter this list.</p></noscript>
<details class="repository-discovery"${view.monitored.length + discovered.length === 0 ? html` open` : ""}><summary>Scan directories</summary><div class="stack">
<form method="get" action="/" class="repository-scan"><label>Directory<input name="root" placeholder="Absolute directory path" value="${view.selectedRoot}"></label><input type="hidden" name="q" value="${view.query}"><input type="hidden" name="filter" value="${view.filter}"><button type="submit">Scan</button></form>
<p class="small muted">Leave the directory empty to use the server's scan directories. Scans stop at repository roots, skip symlinks and hidden directories, and descend up to four levels.</p>
<p class="small">Scanned: ${view.discovery.roots.map((root) => html`<code>${root}</code> `)}</p>
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
    topbar: html`<p class="topbar-title">Review canvas</p><div class="topbar-actions"><button type="button" class="quiet" data-repository-refresh disabled>Refresh</button>${themeToggle}</div>`,
    body: html`<main id="main" class="page stack">
${repositories(repositoryView, reviews)}
<section class="stack" aria-labelledby="reviews-title">
<h2 id="reviews-title">Reviews</h2>
${
  reviews.length === 0
    ? html`<p class="muted">No reviews yet. An agent starts one with <code>review-canvas register</code>.</p>`
    : html`<ul class="review-list stack">${reviews.map(review)}</ul>`
}
</section>
</main>`,
  });
