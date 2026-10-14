/**
 * The page's one way to change the review, as components use it: send an action and learn whether it went through,
 * with the server's refusal in words when it did not.
 */
import { useAtomValue } from "@effect/atom-react";
import { Exit, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { createContext, useCallback, useContext, useRef, useState } from "react";
import type { ReviewId } from "../../schema/primitives.ts";
import type { PageAction } from "../../schema/rpc.ts";
import { type CallError, failureText, NO_ANSWER } from "../rpc.ts";
import { toast } from "../ui/toast.tsx";
import { actionsAtom } from "./data.ts";
import type { View } from "./ui.ts";
import type { PageModel } from "./view.ts";

/** What a change came to: its result, or why it did not go through. */
type Outcome<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly message: string };

/** A change's exit as an outcome. No exit means the change could not be sent: the socket was not ready. */
const outcomeOf = <A>(exit: Exit.Exit<A, CallError> | undefined): Outcome<A> => {
  if (exit === undefined) return { ok: false, message: NO_ANSWER };
  return Exit.isSuccess(exit) ? { ok: true, value: exit.value } : { ok: false, message: failureText(exit.cause) };
};

/**
 * The page for one review: its ID, what it shows now, and how it reads: the reviewer's view, except that a narrow
 * page reads guided.
 */
export const ReviewContext = createContext<{ readonly id: ReviewId; readonly page: PageModel; readonly view: View } | null>(null);

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
    async (action: PageAction, options: { readonly quiet?: boolean } = {}) => {
      const outcome = outcomeOf(actions === undefined ? undefined : await actions.act(action, shown));
      if (!outcome.ok && options.quiet !== true) toast(outcome.message, "danger");
      return outcome;
    },
    [actions, shown],
  );
};

/** Imports a feedback file's text after the changes before it, with what it added or why it was refused. */
export const useImport = () => {
  const { actions, shown } = useActions();
  return useCallback(
    async (text: string) => outcomeOf(actions === undefined ? undefined : await actions.importFeedback(text, shown)),
    [actions, shown],
  );
};

/**
 * One send at a time from a form: `run` does nothing while a send is under way, and `busy` redraws the form's
 * controls. The flag is a ref because state changes only on the next render: Ctrl+Enter twice must send once.
 */
export const useSending = () => {
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const run = async <A>(send: () => Promise<A>): Promise<A | undefined> => {
    if (sending.current) return undefined;
    sending.current = true;
    setBusy(true);
    try {
      return await send();
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  return { busy, run };
};
