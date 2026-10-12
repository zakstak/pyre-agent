import type { Target } from "../../schema/target.ts";
import type { ReviewSummary } from "../../store/store.ts";
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

export const homePage = (
  assets: Assets["Service"],
  reviews: ReadonlyArray<ReviewSummary>,
): Html =>
  page(assets, {
    title: "Review canvas",
    topbar: html`<p class="topbar-title">Review canvas</p><div class="topbar-actions">${themeToggle}</div>`,
    body: html`<main id="main" class="page stack">
<h1>Reviews</h1>
${
  reviews.length === 0
    ? html`<p class="muted">No reviews yet. An agent starts one with <code>review-canvas register</code>.</p>`
    : html`<ul class="review-list stack">${reviews.map(review)}</ul>`
}
</main>`,
  });
