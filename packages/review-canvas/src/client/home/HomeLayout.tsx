/**
 * The snapshot the home page and the repositories settings read, loading or failing, and the home page's frame
 * around it.
 */
import { useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import type { HomeSnapshot } from "../../schema/rpc.ts";
import { failureText } from "../rpc.ts";
import { cn } from "../ui/cn.ts";
import { frame, SkipLink, TopBar } from "../ui/page.tsx";
import { homeAtom } from "./data.ts";

/** The snapshot's content once it has arrived; until then that it is loading, or why it could not be read. */
export const Snapshot = ({
  failure,
  children,
}: {
  /** What to say when the snapshot cannot be read. */
  readonly failure: string;
  readonly children: (snapshot: HomeSnapshot) => React.ReactNode;
}) => {
  const result = useAtomValue(homeAtom);
  const snapshot = AsyncResult.value(result);
  const error =
    AsyncResult.isFailure(result) && !result.waiting
      ? failureText(result.cause, failure)
      : undefined;
  return (
    <>
      {error === undefined ? null : (
        <p className="mb-4 text-danger" role="alert">
          {error}
        </p>
      )}
      {Option.match(snapshot, {
        onNone: () =>
          error === undefined ? (
            <p className="text-muted" role="status">
              Loading…
            </p>
          ) : null,
        onSome: children,
      })}
    </>
  );
};

export const HomeLayout = ({
  actions,
  failure,
  children,
}: {
  readonly actions?: React.ReactNode;
  readonly failure: string;
  readonly children: (snapshot: HomeSnapshot) => React.ReactNode;
}) => (
  <>
    <SkipLink />
    <TopBar width="home">{actions}</TopBar>
    <main
      id="main"
      tabIndex={-1}
      className={cn(frame({ width: "home" }), "pt-8 pb-16")}
    >
      <Snapshot failure={failure}>{children}</Snapshot>
    </main>
  </>
);
