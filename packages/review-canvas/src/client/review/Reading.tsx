/**
 * How the reviewer read the walkthrough's stops, as the contents, the guide, and each stop show it: a mark for each
 * stop, how many are read, a way to mark a stop read or unread, and for a stop a later round changed, which of its
 * files changed and a way to read it again. The server keeps the reading, so every tab and browser shows the same
 * marks. The page reads a stop the reviewer keeps on screen; dwell.ts says when.
 */
import { BookCheck, Check, EyeOff, TriangleAlert } from "lucide-react";
import type { StopRead } from "../../schema/reading.ts";
import { fileElementId } from "../../review/next.ts";
import { count, splitPath } from "../names.ts";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Joined } from "../ui/text.tsx";
import { toast } from "../ui/toast.tsx";
import { usePage, useReadStop, useSending } from "./act.ts";
import { hashOf } from "./places.ts";
import type { PageModel } from "./view.ts";

/** A stop's reading in words, for a reader who hears the page. */
export const READ_TEXT: Readonly<Record<StopRead["state"], string>> = {
  read: "read",
  changed: "changed since you read it",
  unread: "not read",
};

/** How the reviewer read a stop of the round the page shows; a stop the snapshot does not name is unread. */
export const readOf = (page: PageModel, stop: number): StopRead =>
  page.reading.stops.get(stop) ?? { state: "unread" };

/** A read stop's check, or a changed stop's warning; an unread stop has no mark. */
export const ReadMark = ({
  read,
  className,
}: {
  readonly read: StopRead;
  readonly className?: string;
}) => {
  switch (read.state) {
    case "unread":
      return null;
    case "read":
      return (
        <Check
          aria-hidden="true"
          className={cn("size-3.5 shrink-0 text-success", className)}
        />
      );
    case "changed":
      return (
        <TriangleAlert
          aria-hidden="true"
          className={cn("size-3.5 shrink-0 text-warning", className)}
        />
      );
  }
};

/** "2 of 5 stops read": those read at the versions the round shows. A changed stop is not read until read again. */
export const ReadCount = ({ className }: { readonly className?: string }) => {
  const { page } = usePage();
  const { read, total } = page.reading;
  return (
    <span data-read-count className={cn("tabular-nums", className)}>
      {read} of {count(total, "stop")} read
    </span>
  );
};

/**
 * Mark read for a stop not read yet, and Mark unread for a read one, which the page then reads again only once the
 * reviewer comes back to it. A changed stop has Mark read in its notice instead. A closed review changes nothing.
 */
export const ReadToggle = ({
  stop,
  className,
}: {
  readonly stop: number;
  readonly className?: string;
}) => {
  const { page } = usePage();
  const readStop = useReadStop();
  const { busy, run } = useSending();
  const read = readOf(page, stop);
  if (!page.writable || read.state === "changed") return null;
  const marking = read.state === "unread";
  const toggle = async () => {
    const outcome = await run(() => readStop(stop, marking));
    if (outcome !== undefined && !outcome.ok)
      toast(
        `Not marked ${marking ? "read" : "unread"}: ${outcome.message}`,
        "danger",
      );
  };
  const Icon = marking ? BookCheck : EyeOff;
  return (
    <Button
      size="sm"
      variant="quiet"
      {...(marking ? { "data-mark-read": stop } : { "data-mark-unread": stop })}
      disabled={busy}
      onClick={() => void toggle()}
      className={cn("text-muted hover:text-ink", className)}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {marking ? "Mark read" : "Mark unread"}
    </Button>
  );
};

/** A changed stop's files by their names, which a reader reads in a line. */
export const changedNames = (
  read: Extract<StopRead, { state: "changed" }>,
): string => read.files.map((path) => splitPath(path).base).join(", ");

/**
 * For a stop a later round changed: since which round, which of its files changed, as links to them, and Mark read,
 * which reads the stop again at the versions the page shows.
 */
export const StopChanged = ({
  stop,
  className,
}: {
  readonly stop: number;
  readonly className?: string;
}) => {
  const { page } = usePage();
  const readStop = useReadStop();
  const { busy, run } = useSending();
  const read = readOf(page, stop);
  if (read.state !== "changed") return null;
  const markRead = async () => {
    const outcome = await run(() => readStop(stop));
    if (outcome !== undefined && !outcome.ok)
      toast(`Not marked read: ${outcome.message}`, "danger");
  };
  return (
    <div
      data-stop-changed={stop}
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 text-small",
        className,
      )}
    >
      <p className="min-w-0">
        <TriangleAlert
          aria-hidden="true"
          className="mr-1.5 inline size-3.5 align-[-0.125em] text-warning"
        />
        <strong className="font-semibold text-warning">
          Changed since you read it
        </strong>{" "}
        <span className="text-muted">in round {read.round}:</span>{" "}
        <Joined
          items={read.files.map((path) =>
            page.files.has(path) ? (
              <a
                href={hashOf(fileElementId(path))}
                data-changed-file={path}
                title={path}
                className="text-link underline underline-offset-3"
              >
                <code>{splitPath(path).base}</code>
              </a>
            ) : (
              <code title={path}>{splitPath(path).base}</code>
            ),
          )}
        />
      </p>
      {page.writable ? (
        <Button
          size="sm"
          data-mark-read={stop}
          disabled={busy}
          onClick={() => void markRead()}
        >
          <Check aria-hidden="true" className="size-3.5" />
          Mark read
        </Button>
      ) : null}
    </div>
  );
};
