/**
 * Whether an agent listens to the review: in the top bar beside the connection state, and under what the reviewer
 * sends while none does, so a question never just waits without saying whether anyone will read it.
 */
import { useAtomValue } from "@effect/atom-react";
import { cva } from "class-variance-authority";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { unheard } from "../../review/presence.ts";
import type { Presence } from "../../schema/presence.ts";
import type { ReviewId } from "../../schema/primitives.ts";
import type { Thread } from "../../schema/thread.ts";
import { threadName, threadNameOf } from "../names.ts";
import { connectionAtom } from "../rpc.ts";
import { cn } from "../ui/cn.ts";
import { Time } from "../ui/text.tsx";
import { presenceAtom } from "./data.ts";

/** The agents of a review as one name: its only thread's, or "the agents". */
export const agentsName = (threads: ReadonlyArray<Thread>): string => {
  const [only, ...others] = threads;
  return only === undefined || others.length > 0
    ? "the agents"
    : threadName(only.label);
};

/** What the page says under something sent that no agent will read until one checks in. */
export const notListeningText = (who: string): string =>
  who === "the agents"
    ? "The agents aren’t listening; they will see this when they check in."
    : `${who} isn’t listening; it will see this when it checks in.`;

/** The review's presence as the server last sent it, while the page is connected; unknown otherwise. */
export const usePresence = (id: ReviewId): Presence | undefined => {
  const connection = useAtomValue(connectionAtom);
  const presence = AsyncResult.value(useAtomValue(presenceAtom(id))).pipe(
    Option.getOrUndefined,
  );
  return connection.state === "connected" ? presence : undefined;
};

const dot = cva("inline-block size-2 flex-none rounded-full", {
  variants: {
    state: {
      listening: "bg-success",
      away: "bg-muted",
      never: "border border-muted",
    },
  },
});

/** Each name once, joined as running text. */
const joined = (names: ReadonlyArray<string>): string => {
  const unique = [...new Set(names)];
  return unique.length <= 1
    ? (unique[0] ?? "")
    : `${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}`;
};

/** The agents' presence in the top bar: listening, last seen at a time, or never connected. */
export const AgentPresence = ({
  id,
  threads,
}: {
  readonly id: ReviewId;
  readonly threads: ReadonlyArray<Thread>;
}) => {
  const presence = usePresence(id);
  if (presence === undefined) return null;
  const said = (() => {
    switch (presence.state) {
      case "listening":
        return (
          <>
            {joined(
              presence.threads.map((thread) => threadNameOf(threads, thread)),
            )}{" "}
            listening
          </>
        );
      case "away":
        return (
          <>
            {threadNameOf(threads, presence.thread)} last seen{" "}
            <Time at={presence.seen_at} />
          </>
        );
      case "never": {
        const who = agentsName(threads);
        return who === "the agents"
          ? "No agent connected"
          : `${who} never connected`;
      }
    }
  })();
  return (
    <span
      data-presence={presence.state}
      role="status"
      title={
        presence.state === "listening"
          ? "An agent waits for what you send, and answers questions at once."
          : "No agent waits for you now. What you send waits until one checks in."
      }
      className={cn(
        "inline-flex items-center gap-1.5 text-small",
        presence.state === "listening" ? "text-ink" : "text-muted",
      )}
    >
      <span aria-hidden="true" className={dot({ state: presence.state })} />
      <span>{said}</span>
    </span>
  );
};

/**
 * Under what the reviewer sent at `sent` for `who` to read: that no agent listens and none checked in since, until
 * one does.
 */
export const NotListening = ({
  id,
  who,
  sent,
  className,
}: {
  readonly id: ReviewId;
  readonly who: string;
  readonly sent: string;
  readonly className?: string;
}) => {
  const presence = usePresence(id);
  if (presence === undefined || !unheard(presence, sent)) return null;
  return (
    <p
      data-not-listening
      role="status"
      className={cn("text-small text-warning", className)}
    >
      {notListeningText(who)}
    </p>
  );
};
