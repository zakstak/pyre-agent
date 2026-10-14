/** The reviews, with what each needs from the reviewer: those that need them first, closed ones last. */
import { Archive, CircleCheck, CircleX, Eye, FileDiff, Hourglass, type LucideIcon, MessageCircle, MessageSquare } from "lucide-react";
import type { Verdict } from "../../schema/feedback.ts";
import type { ReviewSummary } from "../../schema/rpc.ts";
import { count, VERDICT_TEXT } from "../names.ts";
import { TOUCH_TARGET } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Stat } from "../ui/stat.tsx";
import { TargetText } from "../ui/target.tsx";
import { Time, timeTitle } from "../ui/text.tsx";
import { AgentVoice } from "../ui/voice.tsx";

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

const VERDICT_STAT: Readonly<Record<Verdict, { readonly icon: LucideIcon; readonly tone: "success" | "danger" | "muted" }>> = {
  approve: { icon: CircleCheck, tone: "success" },
  request_changes: { icon: CircleX, tone: "danger" },
  comment: { icon: MessageCircle, tone: "muted" },
};

/**
 * What a review stands at, as icons and numbers at the right of its row. One is in the action colour when the move is
 * the reviewer's: answers to read first, then files left, then Finish.
 */
const Stats = ({ item }: { readonly item: ReviewSummary }) => {
  if (item.closed_at !== undefined) return <Stat icon={Archive} title="Closed · replaced by a fresh start" />;
  if (item.round === undefined)
    return <Stat icon={Hourglass} title={`Waiting for the first round · started ${timeTitle(item.created_at)}`} />;
  const progress = item.progress;
  const viewed = (tone: "action" | "muted") =>
    progress === undefined ? null : (
      <Stat icon={Eye} tone={tone} title={`${progress.viewed} of ${count(progress.viewable, "file")} viewed`}>
        {progress.viewed}/{progress.viewable}
      </Stat>
    );
  // As on the review page: a finished round is the agents' turn, whatever waits after it.
  if (item.verdict !== undefined) {
    const verdict = VERDICT_STAT[item.verdict];
    return (
      <>
        <Stat icon={verdict.icon} tone={verdict.tone} title={`Round ${item.round} finished · ${VERDICT_TEXT[item.verdict]}`} />
        {viewed("muted")}
      </>
    );
  }
  const forYou = progress?.forYou ?? 0;
  const left = progress === undefined ? 0 : progress.viewable - progress.viewed;
  const drift = item.drift ?? 0;
  return (
    <>
      {forYou === 0 ? null : (
        <Stat icon={MessageSquare} tone="action" title={`${count(forYou, "answer")} to read`}>
          {forYou}
        </Stat>
      )}
      {viewed(forYou === 0 && left > 0 ? "action" : "muted")}
      {drift === 0 ? null : (
        <Stat icon={FileDiff} tone="warning" title={`${count(drift, "file")} changed since the round`}>
          {drift}
        </Stat>
      )}
      {forYou === 0 && left === 0 ? (
        <Stat icon={CircleCheck} tone="action" title={`Finish round ${item.round}`}>
          Finish
        </Stat>
      ) : null}
    </>
  );
};

const ReviewRow = ({ item }: { readonly item: ReviewSummary }) => {
  const state = standing(item);
  const closed = item.closed_at !== undefined;
  return (
    <li
      data-standing={state}
      className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 py-3 max-md:grid-cols-[1.25rem_minmax(0,1fr)]"
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
        <p className="flex flex-wrap items-center gap-x-2.5 text-small text-muted">
          <TargetText target={item.target} />
          {item.threads.length === 0 ? null : (
            <span className="inline-flex flex-wrap items-center gap-x-2.5">
              {item.threads.map((thread) => (
                <AgentVoice key={thread.id} label={thread.label} />
              ))}
            </span>
          )}
          {closed || item.round === undefined ? null : <span>Round {item.round}</span>}
        </p>
      </div>
      <p className="flex flex-wrap items-center justify-end gap-x-2.5 gap-y-1 self-start text-small max-md:col-start-2 max-md:justify-start">
        <Stats item={item} />
        <span className="text-muted">
          <Time at={item.closed_at ?? item.published_at ?? item.created_at} />
        </span>
      </p>
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
        <ul>
          {sorted.map((item) => (
            <ReviewRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </section>
  );
};
