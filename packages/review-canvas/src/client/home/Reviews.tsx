/**
 * The reviews, with what each needs from the reviewer: those that need them first, closed ones last. A query narrows
 * them, as on GitHub's pull request list; the standing chips write its `is:` term.
 */
import { useAtom } from "@effect/atom-react";
import { Archive, Check, CircleCheck, CircleX, FileDiff, Hourglass, type LucideIcon, MessageCircle } from "lucide-react";
import type { Verdict } from "../../schema/feedback.ts";
import { facetValues, isStateTerm, STATE_OPTIONS, withoutKey, withoutState } from "../../review/facets.ts";
import { formatQuery, hasStanding, matches, parseQuery, type Query, type Standing, standing, withoutStanding, withStanding } from "../../review/query.ts";
import type { ReviewSummary } from "../../schema/rpc.ts";
import { count, VERDICT_TEXT } from "../names.ts";
import { TOUCH_TARGET } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { FIELD } from "../ui/field.ts";
import { AnswerStat, Stat } from "../ui/stat.tsx";
import { TargetText } from "../ui/target.tsx";
import { Time, timeTitle } from "../ui/text.tsx";
import { AgentVoice } from "../ui/voice.tsx";
import { reviewQueryAtom } from "./data.ts";
import { FilterMenu, type MenuRow } from "./FilterMenu.tsx";

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
      <Stat icon={Check} tone={tone} title={`${progress.viewed} of ${count(progress.viewable, "file")} viewed`}>
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
        <AnswerStat count={forYou} title={`${count(forYou, "answer")} to read`} />
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

/** The standing chips, each the `is:` term it writes. */
const CHIPS = [
  ["open", "Open"],
  ["yours", "Needs you"],
  ["waiting", "Waiting"],
  ["closed", "Closed"],
] as const;

export const Reviews = ({ reviews }: { readonly reviews: ReadonlyArray<ReviewSummary> }) => {
  const [text, setText] = useAtom(reviewQueryAtom);
  const query = parseQuery(text);
  // Each chip counts the reviews the rest of the query leaves.
  const rest = withoutStanding(query);
  const left = reviews.filter((item) => matches(rest, item));
  // Newest first within each standing, as the server lists them; the sort is stable.
  const shown = reviews
    .filter((item) => matches(query, item))
    .sort((a, b) => STANDING_ORDER[standing(a)] - STANDING_ORDER[standing(b)]);
  const menu = { reviews, query, onQuery: (next: Query) => setText(formatQuery(next)) };
  return (
    <section aria-labelledby="reviews-title">
      <h2 id="reviews-title" className="mb-3 text-heading font-semibold">
        Reviews
      </h2>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div role="group" aria-label="Show" className="inline-flex overflow-hidden rounded-control border border-line text-small">
          {CHIPS.map(([value, label]) => {
            const pressed = hasStanding(query, value);
            const term = parseQuery(`is:${value}`);
            return (
              <button
                key={value}
                type="button"
                data-standing-filter={value}
                aria-pressed={pressed}
                onClick={() => setText(formatQuery(withStanding(query, value)))}
                className={cn(
                  TOUCH_TARGET,
                  "h-7 px-2.5 font-medium",
                  pressed ? "bg-selected text-ink shadow-pressed" : "bg-raised text-muted hover:bg-subtle",
                )}
              >
                {label} <span className="font-normal tabular-nums">{left.filter((item) => matches(term, item)).length}</span>
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <FilterMenu
            name="repo"
            label="Repo"
            finds="repositories"
            groups={[facetValues(reviews, "repo").map(({ value }): MenuRow => ({ key: "repo", value, exclusive: true, label: value }))]}
            {...menu}
            active={query.terms.some((term) => term.key === "repo")}
            clear={(next) => withoutKey(next, "repo")}
          />
          <FilterMenu
            name="author"
            label="Author"
            finds="authors"
            groups={[
              facetValues(reviews, "author").map(
                ({ value }): MenuRow => ({ key: "author", value, exclusive: true, label: value, content: <AgentVoice label={value} /> }),
              ),
            ]}
            {...menu}
            active={query.terms.some((term) => term.key === "author")}
            clear={(next) => withoutKey(next, "author")}
          />
          <FilterMenu
            name="state"
            label="State"
            finds="states"
            groups={STATE_OPTIONS}
            {...menu}
            active={query.terms.some(isStateTerm)}
            clear={withoutState}
          />
        </div>
        <label className="max-w-96 min-w-0 flex-[1_1_16rem]">
          <input
            type="search"
            aria-label="Filter reviews"
            placeholder="is:open repo:ledger -author:codex"
            value={text}
            onChange={(event) => setText(event.currentTarget.value)}
            className={FIELD}
          />
        </label>
      </div>
      <p className="sr-only" role="status">
        {shown.length} of {reviews.length} reviews shown
      </p>
      {reviews.length === 0 ? (
        <p className="text-muted">
          No reviews yet. An agent starts one with <code>review-canvas register</code>.
        </p>
      ) : shown.length === 0 ? (
        <p className="text-muted">No reviews match.</p>
      ) : (
        <ul>
          {shown.map((item) => (
            <ReviewRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </section>
  );
};
