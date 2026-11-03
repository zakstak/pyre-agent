/**
 * The strip under the title that names the one thing to do next, with the round's steps at its right: the answers to
 * read, the files to view, the comments pending until the finish, and the finish. It sticks under the top bar on a
 * wide page; the bars' heights are measured here for what sticks under them and what the page scrolls to.
 */
import { Menu } from "@base-ui/react/menu";
import { ArrowRight, Check, MessageSquareDashed } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import type { Comment } from "../../schema/feedback.ts";
import type { CommentId } from "../../schema/primitives.ts";
import { count, lineRange, VERDICT_TEXT } from "../names.ts";
import { buttonVariants, TOUCH_TARGET } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { AnswerStat, Stat } from "../ui/stat.tsx";
import { usePage } from "./act.ts";
import { hashOf } from "./places.ts";

const Kbd = ({ children }: { readonly children: string }) => (
  <kbd className="inline-block rounded-sm border border-line px-[0.3em] leading-[1.3] font-semibold text-muted">
    {children}
  </kbd>
);

/** A step of the round in the strip, as a link: underlined on hover only. */
const STEP_LINK =
  "inline-flex min-h-11 items-center no-underline hover:underline";

/** A step's link to an element of the page, which `onGo` brings into view. */
const StepLink = ({
  target,
  onGo,
  children,
}: {
  readonly target: string;
  readonly onGo: () => void;
  readonly children: React.ReactNode;
}) => (
  <a
    href={hashOf(target)}
    onClick={(event) => {
      event.preventDefault();
      onGo();
    }}
    className={STEP_LINK}
  >
    {children}
  </a>
);

/** Where a pending comment is, as its row in the pending list names it. */
const placeOf = (comment: Comment): string =>
  comment.kind === "general"
    ? "On the whole change"
    : `${comment.anchor.path}:${lineRange(comment.anchor.start_line, comment.anchor.end_line)}`;

/** The first line of a comment, as a row of a list shows it. */
const firstLine = (body: string): string => body.trim().split("\n", 1)[0] ?? "";

/**
 * The comments Finish review sends, as a count that opens their list. Choosing one goes to it and focuses it, so the
 * reviewer can read, edit, or delete it before finishing.
 */
const PendingStep = ({
  onComment,
}: {
  readonly onComment: (comment: CommentId) => void;
}) => {
  const { page } = usePage();
  // A chosen comment takes focus itself; Esc or a click outside gives it back to the count.
  const chosen = useRef(false);
  const pending = page.pending.length;
  return (
    <Menu.Root
      modal={false}
      onOpenChange={(open) => {
        if (open) chosen.current = false;
      }}
    >
      <Menu.Trigger
        data-pending-count={pending}
        title={`${count(pending, "comment")} pending: Finish review sends ${pending === 1 ? "it" : "them"}`}
        className={cn(
          TOUCH_TARGET,
          "inline-flex min-h-11 items-center gap-1 font-semibold text-warning tabular-nums hover:underline",
        )}
      >
        <MessageSquareDashed aria-hidden="true" className="size-3.5" />
        {pending} pending
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={4} align="end" className="z-40">
          <Menu.Popup
            data-pending-list
            finalFocus={() => !chosen.current}
            className="max-h-80 w-[min(24rem,calc(100vw-2rem))] overflow-y-auto rounded-control border border-line bg-raised py-1 text-small shadow-md outline-none"
          >
            <Menu.Group>
              <Menu.GroupLabel className="px-3 py-1.5 text-muted">
                Sent with your review
              </Menu.GroupLabel>
              {page.pending.map((comment) => (
                <Menu.Item
                  key={comment.id}
                  data-pending-comment={comment.id}
                  onClick={() => {
                    chosen.current = true;
                    onComment(comment.id);
                  }}
                  className={cn(
                    TOUCH_TARGET,
                    "flex cursor-pointer flex-col px-3 py-1.5 outline-none select-none data-highlighted:bg-subtle",
                  )}
                >
                  <code className="truncate text-muted">
                    {placeOf(comment)}
                  </code>
                  <span className="truncate text-ink">
                    {firstLine(comment.body)}
                  </span>
                </Menu.Item>
              ))}
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
};

/**
 * The round's steps, in order: the answers to read while any wait, the files to view, the comments pending until the
 * finish, and the finish. The step the strip names is in ink; the others still work.
 */
const Steps = ({
  onGo,
  onFinish,
  onComment,
}: {
  readonly onGo: (step: "answer" | "file") => void;
  readonly onFinish: () => void;
  readonly onComment: (comment: CommentId) => void;
}) => {
  const { page } = usePage();
  const { viewable: total, forYou } = page.progress;
  const viewed = page.progress.viewed.size;
  const current = page.strip.kind === "go" ? page.strip.next.kind : undefined;
  const filesDone = viewed === total;
  const files = (
    <Stat
      data-viewed-count
      icon={Check}
      tone={current === "file" ? "ink" : "muted"}
      iconClassName={filesDone ? "text-success" : undefined}
      className={current === "file" ? "font-semibold" : undefined}
      title={`${viewed} of ${count(total, "file")} viewed`}
    >
      {viewed}/{total}
    </Stat>
  );
  return (
    <ol
      aria-label={`Round ${page.round.round}`}
      className="m-0 ml-auto flex list-none flex-wrap items-center gap-x-5 p-0"
    >
      {forYou === 0 || page.steps.answer === undefined ? null : (
        <li>
          <StepLink
            target={page.steps.answer.target}
            onGo={() => onGo("answer")}
          >
            <AnswerStat
              data-for-you
              count={forYou}
              title={`${count(forYou, "answer")} to read`}
            />
          </StepLink>
        </li>
      )}
      <li>
        {page.steps.file === undefined ? (
          files
        ) : (
          <StepLink target={page.steps.file.target} onGo={() => onGo("file")}>
            {files}
          </StepLink>
        )}
      </li>
      {page.pending.length === 0 ? null : (
        <li>
          <PendingStep onComment={onComment} />
        </li>
      )}
      {!page.writable || page.finished ? null : (
        <li>
          <a
            href="#finish"
            data-open-finish
            onClick={(event) => {
              event.preventDefault();
              onFinish();
            }}
            className={buttonVariants({
              variant: current === "finish" ? "primary" : "quiet",
              size: "sm",
            })}
          >
            Finish
          </a>
        </li>
      )}
    </ol>
  );
};

export const NextStrip = ({
  onGo,
  onStep,
  onFinish,
  onComment,
}: {
  readonly onGo: () => void;
  readonly onStep: (step: "answer" | "file") => void;
  readonly onFinish: () => void;
  /** Goes to a comment and focuses it, as a row of the pending list does. */
  readonly onComment: (comment: CommentId) => void;
}) => {
  const { page } = usePage();
  const { strip } = page;
  return (
    <section
      data-next
      aria-label="Next"
      className="sticky top-(--topbar-height) z-10 col-span-full -mx-6 min-w-0 bg-raised px-6 text-small max-md:static max-md:-mx-4 max-md:px-4"
    >
      <div className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1">
        {strip.kind === "go" ? (
          <a
            href={hashOf(strip.next.target)}
            data-next-go
            data-target={strip.next.target}
            data-kind={strip.next.kind}
            onClick={(event) => {
              event.preventDefault();
              onGo();
            }}
            className="-ml-2 inline-flex min-h-11 min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 rounded-control px-2 py-1 font-semibold text-ink no-underline hover:bg-subtle"
          >
            <span
              aria-hidden="true"
              className="inline-grid size-6 flex-none place-items-center rounded-control bg-accent text-chip text-on-accent"
            >
              <ArrowRight className="size-3.5" />
            </span>
            <span className="min-w-0 break-words">
              {strip.what}
              {strip.code === undefined ? null : (
                <>
                  {" "}
                  <code className="font-semibold">{strip.code}</code>
                </>
              )}
            </span>{" "}
            <span className="min-w-0 font-normal text-muted">
              <span aria-hidden="true">· </span>
              {strip.why}
            </span>
          </a>
        ) : strip.kind === "finished" ? (
          <p className="py-2.5">
            <strong>You finished round {strip.round}</strong>{" "}
            <span className="text-muted">
              · {VERDICT_TEXT[strip.verdict]} · the agents have the turn
            </span>
          </p>
        ) : (
          <p className="py-2.5">
            <strong>Closed</strong>{" "}
            <span className="text-muted">· replaced by a fresh start</span>
            {page.snapshot.replaced_by === undefined ? null : (
              <>
                {" "}
                ·{" "}
                <a
                  href={`/reviews/${page.snapshot.replaced_by}`}
                  className="text-link underline underline-offset-3"
                >
                  Open the newer review
                </a>
              </>
            )}
          </p>
        )}
        {strip.kind === "go" ? (
          <span
            aria-hidden="true"
            className="text-muted max-md:hidden pointer-coarse:hidden"
          >
            <Kbd>n</Kbd> next · <Kbd>j</Kbd> <Kbd>k</Kbd> stops
          </span>
        ) : null}
        <Steps onGo={onStep} onFinish={onFinish} onComment={onComment} />
      </div>
    </section>
  );
};

/** The sticky bars' heights, for what sticks under them and what the page scrolls to. */
export const useStickyBars = () => {
  useLayoutEffect(() => {
    const measure = () => {
      const bar = document.querySelector<HTMLElement>("[data-topbar]");
      const strip = document.querySelector<HTMLElement>("[data-next]");
      const barSticks =
        bar !== null && getComputedStyle(bar).position === "sticky";
      const stripSticks =
        strip !== null && getComputedStyle(strip).position === "sticky";
      const top = barSticks ? (bar?.offsetHeight ?? 0) : 0;
      document.documentElement.style.setProperty("--topbar-height", `${top}px`);
      const sticky = top + (stripSticks ? (strip?.offsetHeight ?? 0) : 0) + 8;
      document.documentElement.style.setProperty("--sticky-top", `${sticky}px`);
      // What a jump to a row, a note, or a thread keeps above it: the file's header and a line of code.
      document.documentElement.style.setProperty(
        "--scroll-top",
        `calc(${sticky}px + 3.75rem)`,
      );
    };
    const observer = new ResizeObserver(measure);
    for (const element of document.querySelectorAll(
      "[data-topbar], [data-next]",
    ))
      observer.observe(element);
    measure();
    addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      removeEventListener("resize", measure);
    };
  }, []);
};
