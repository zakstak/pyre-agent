/**
 * The home page: the reviews, with what each needs from the reviewer, then the repositories on this machine with
 * their checkouts and reviews, and the scan form. The server builds the snapshot; the page filters it.
 */
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { count } from "../names.ts";
import { CONNECTION_TEXT, connectionAtom, failureText } from "../rpc.ts";
import { Button } from "../ui/button.tsx";
import { SkipLink } from "../ui/page.tsx";
import { ThemeControl } from "../ui/theme.tsx";
import { busyAtom, homeAtom, monitoringAtom } from "./data.ts";
import { Repositories } from "./Repositories.tsx";
import { Reviews } from "./Reviews.tsx";

export const HomePage = () => {
  const result = useAtomValue(homeAtom);
  const busy = useAtomValue(busyAtom);
  const connection = useAtomValue(connectionAtom);
  const refresh = useAtomRefresh(homeAtom);
  const setMonitoring = useAtomSet(monitoringAtom);
  const snapshot = AsyncResult.value(result);
  const failure =
    AsyncResult.isFailure(result) && !result.waiting
      ? failureText(result.cause, "Could not load the repositories. Rescan to try again.")
      : undefined;
  const rescan = () => {
    // A rescan starts afresh, as reloading the page did: the last change's refusal goes with the old lists.
    setMonitoring(Atom.Reset);
    refresh();
  };
  return (
    <>
      <SkipLink />
      <header className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-surface px-5 py-1 text-small max-md:px-4">
        <div className="flex min-w-0 flex-[1_1_12rem] flex-wrap items-baseline gap-x-2">
          <h1 className="font-semibold">Review canvas</h1>
          <span className="text-muted">
            localhost
            {Option.match(snapshot, {
              onNone: () => "",
              onSome: ({ repositories }) =>
                ` · ${count(repositories.filter((entry) => entry.monitored).length, "repository", "repositories")} monitored`,
            })}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="text-muted empty:hidden" role="status" data-connection="">
            {CONNECTION_TEXT[connection.state]}
          </span>
          <Button size="sm" className="text-muted hover:text-ink" disabled={busy} onClick={rescan}>
            Rescan
          </Button>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto box-content max-w-work px-5 pt-10 pb-12 max-md:px-4">
        {failure === undefined ? null : (
          <p className="mb-4 text-danger" role="alert">
            {failure}
          </p>
        )}
        {Option.match(snapshot, {
          onNone: () =>
            failure === undefined ? (
              <p className="text-muted" role="status">
                Loading…
              </p>
            ) : null,
          onSome: (home) => (
            <>
              <Reviews reviews={home.reviews} />
              <Repositories snapshot={home} />
            </>
          ),
        })}
      </main>
      <footer className="mx-auto mb-8 box-content max-w-work px-5 max-md:px-4">
        <ThemeControl />
      </footer>
    </>
  );
};
