/**
 * The page's one way to change the review, as components use it: send an action and learn whether it went through,
 * with the server's refusal in words when it did not.
 */
import { useAtomSet } from "@effect/atom-react";
import { Cause, Exit, Option } from "effect";
import { createContext, useCallback, useContext } from "react";
import type { ReviewId } from "../../schema/primitives.ts";
import { type PageAction, Refused } from "../../schema/rpc.ts";
import { toast } from "../ui/toast.tsx";
import { actAtom, importAtom } from "./data.ts";
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

/** Sends an action after the ones before it. `quiet` leaves showing a refusal to the caller. */
export const useAct = () => {
  const { id } = usePage();
  const run = useAtomSet(actAtom(id), { mode: "promiseExit" });
  return useCallback(
    async (action: PageAction, options: { readonly quiet?: boolean } = {}): Promise<Outcome> => {
      const exit = await run(action);
      if (Exit.isSuccess(exit)) return { ok: true };
      const message = failureMessage(exit.cause);
      if (options.quiet !== true) toast(message, "danger");
      return { ok: false, message };
    },
    [run],
  );
};

export const useImport = () => {
  const { id } = usePage();
  return useAtomSet(importAtom(id), { mode: "promiseExit" });
};
