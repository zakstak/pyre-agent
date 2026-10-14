/**
 * The page's one way to change the review, as components use it: send an action and learn whether it went through,
 * with the server's refusal in words when it did not.
 */
import { useAtomValue } from "@effect/atom-react";
import { Cause, Exit, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { createContext, useCallback, useContext } from "react";
import type { ReviewId } from "../../schema/primitives.ts";
import { type ImportReport, type PageAction, Refused } from "../../schema/rpc.ts";
import { toast } from "../ui/toast.tsx";
import { actionsAtom } from "./data.ts";
import type { PageModel } from "./view.ts";

export type Outcome = { readonly ok: true } | { readonly ok: false; readonly message: string };

const NO_ANSWER = "The server did not answer. Is it still running?";

/** Why a failed call failed, as the page says it: the server's refusal, or that it did not answer. */
export const failureMessage = (cause: Cause.Cause<unknown>): string =>
  Cause.findErrorOption(cause).pipe(
    Option.filter((error): error is Refused => error instanceof Refused),
    Option.map((refused) => refused.message),
    Option.getOrElse(() => NO_ANSWER),
  );

/** The page for one review: its ID and what it shows now. */
export const ReviewContext = createContext<{ readonly id: ReviewId; readonly page: PageModel } | null>(null);

export const usePage = () => {
  const value = useContext(ReviewContext);
  if (value === null) throw new Error("usePage needs a ReviewContext");
  return value;
};

/** The page's changes for the review it shows, once the RPC client is ready. */
const useActions = () => {
  const { id, page } = usePage();
  const actions = Option.getOrUndefined(AsyncResult.value(useAtomValue(actionsAtom(id))));
  return { actions, shown: page.snapshot.revision };
};

/** Sends an action after the ones before it. `quiet` leaves showing a refusal to the caller. */
export const useAct = () => {
  const { actions, shown } = useActions();
  return useCallback(
    async (action: PageAction, options: { readonly quiet?: boolean } = {}): Promise<Outcome> => {
      const exit = actions === undefined ? undefined : await actions.act(action, shown);
      if (exit !== undefined && Exit.isSuccess(exit)) return { ok: true };
      const message = exit === undefined ? NO_ANSWER : failureMessage(exit.cause);
      if (options.quiet !== true) toast(message, "danger");
      return { ok: false, message };
    },
    [actions, shown],
  );
};

/** Imports a feedback file's text after the changes before it, with what it added or why it was refused. */
export const useImport = () => {
  const { actions, shown } = useActions();
  return useCallback(
    async (text: string): Promise<{ readonly ok: true; readonly report: ImportReport } | { readonly ok: false; readonly message: string }> => {
      const exit = actions === undefined ? undefined : await actions.importFeedback(text, shown);
      if (exit !== undefined && Exit.isSuccess(exit)) return { ok: true, report: exit.value };
      return { ok: false, message: exit === undefined ? NO_ANSWER : failureMessage(exit.cause) };
    },
    [actions, shown],
  );
};
