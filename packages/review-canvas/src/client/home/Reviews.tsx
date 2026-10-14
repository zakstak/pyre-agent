/** The reviews, with what each needs from the reviewer: those that need them first, closed ones last. */
import type { ReviewSummary } from "../../schema/rpc.ts";
import { count, VERDICT_TEXT } from "../names.ts";
import { TOUCH_TARGET } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { TargetText, ThreadName } from "../ui/target.tsx";
import { Joined, Time } from "../ui/text.tsx";

/** Whose move a review waits for, which its dot shows. */
type Standing = "yours" | "agents" | "closed";

const standing = (item: ReviewSummary): Standing =>
  item.closed_at !== undefined ? "closed" : item.round !== undefined && !item.submitted ? "yours" : "agents";

const STANDING_ORDER: Readonly<Record<Standing, number>> = { yours: 0, agents: 1, closed: 2 };

const STANDING_LABEL: Readonly<Record<Standing, string>> = {
  yours: "Needs you",
  agents: "Waiting on agents",
  closed: "Closed",
};

/** The one thing a review needs, in bold at the right of its row; the action colour when it is the reviewer's. */
const needs = (item: ReviewSummary): { readonly text: string; readonly yours: boolean } | undefined => {
  if (item.closed_at !== undefined) return undefined;
  if (item.round === undefined) return { text: "Waiting for the first round", yours: false };
  // As on the review page: a finished round is the agents' turn, whatever waits after it.
  if (item.verdict !== undefined)
    return { text: `Round ${item.round} finished · ${VERDICT_TEXT[item.verdict]}`, yours: false };
  const progress = item.progress;
  if (progress !== undefined && progress.forYou > 0)
    return { text: `${count(progress.forYou, "answer")} to read`, yours: true };
  const left = progress === undefined ? 0 : progress.viewable - progress.viewed;
  return left > 0
    ? { text: `${count(left, "file")} to review`, yours: true }
    : { text: `Finish round ${item.round}`, yours: true };
};

const ReviewRow = ({ item }: { readonly item: ReviewSummary }) => {
  const state = standing(item);
  const need = needs(item);
  const closed = item.closed_at !== undefined;
  return (
    <li
      data-standing={state}
      className="grid grid-cols-[1.25rem_minmax(0,1fr)_18rem] gap-x-3 gap-y-0.5 px-4 py-3 max-md:grid-cols-[1.25rem_minmax(0,1fr)]"
    >
      <span
        role="img"
        aria-label={STANDING_LABEL[state]}
        className={cn(
          "mt-2 size-2.5 self-start rounded-full",
          state === "yours" && "bg-action",
          state === "agents" && "border-2 border-muted",
          state === "closed" && "border-2 border-dashed border-muted",
        )}
      />
      <div className="min-w-0">
        <a
          href={`/reviews/${item.id}`}
          className={cn(
            TOUCH_TARGET,
            "font-semibold text-ink no-underline hyphens-auto wrap-anywhere hover:underline",
            closed && "text-muted",
          )}
        >
          {item.target.title}
        </a>
        <p className="flex flex-wrap gap-x-2.5 text-small text-muted">
          <TargetText target={item.target} />
          {item.threads.length === 0 ? null : (
            <span>
              <Joined items={item.threads.map((thread) => <ThreadName thread={thread} />)} />
            </span>
          )}
          {closed ? (
            <span>closed · replaced by a fresh start</span>
          ) : item.round === undefined ? null : (
            <span>Round {item.round}</span>
          )}
        </p>
      </div>
      <div className="text-end text-small max-md:col-start-2 max-md:text-start">
        {need === undefined ? null : <p className={cn("font-semibold", need.yours && "text-action")}>{need.text}</p>}
        <p className="text-muted">
          {item.progress === undefined || closed ? "" : `${item.progress.viewed} of ${item.progress.viewable} viewed · `}
          {item.drift === undefined || closed || item.verdict !== undefined
            ? ""
            : `${count(item.drift, "file")} changed since the round · `}
          {item.closed_at !== undefined ? (
            <Time at={item.closed_at} />
          ) : item.published_at === undefined ? (
            <>
              started <Time at={item.created_at} />
            </>
          ) : (
            <Time at={item.published_at} />
          )}
        </p>
      </div>
    </li>
  );
};

export const Reviews = ({ reviews }: { readonly reviews: ReadonlyArray<ReviewSummary> }) => {
  // Newest first within each standing, as the server lists them; the sort is stable.
  const sorted = [...reviews].sort((a, b) => STANDING_ORDER[standing(a)] - STANDING_ORDER[standing(b)]);
  const tally: Record<Standing, number> = { yours: 0, agents: 0, closed: 0 };
  for (const item of reviews) tally[standing(item)]++;
  const summary = [
    ...(tally.yours === 0 ? [] : [`${tally.yours} need${tally.yours === 1 ? "s" : ""} you`]),
    ...(tally.agents === 0 ? [] : [`${tally.agents} waiting on agents`]),
    ...(tally.closed === 0 ? [] : [`${tally.closed} closed`]),
  ].join(" · ");
  return (
    <section aria-labelledby="reviews-title">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-2">
        <h2 id="reviews-title" className="text-heading font-semibold">
          Reviews
        </h2>
        {summary === "" ? null : <span className="text-small text-muted">{summary}</span>}
      </div>
      {reviews.length === 0 ? (
        <p className="text-muted">
          No reviews yet. An agent starts one with <code>review-canvas register</code>.
        </p>
      ) : (
        <ul className="divide-y divide-separator rounded-control border border-separator bg-surface">
          {sorted.map((item) => (
            <ReviewRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </section>
  );
};
