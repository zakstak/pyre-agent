/**
 * What the home and repositories pages share: the top bar, the snapshot loading or failing, and the theme control in
 * the footer. Both read the same snapshot from the server and filter it in the page.
 */
import { useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import type { HomeSnapshot } from "../../schema/rpc.ts";
import { failureText } from "../rpc.ts";
import { cn } from "../ui/cn.ts";
import { frame, SkipLink, TopBar } from "../ui/page.tsx";
import { ThemeControl } from "../ui/theme.tsx";
import { homeAtom } from "./data.ts";

export const HomeLayout = ({
  place,
  actions,
  failure,
  children,
}: {
  readonly place?: React.ReactNode;
  readonly actions?: React.ReactNode;
  /** What to say when the snapshot cannot be read. */
  readonly failure: string;
  readonly children: (snapshot: HomeSnapshot) => React.ReactNode;
}) => {
  const result = useAtomValue(homeAtom);
  const snapshot = AsyncResult.value(result);
  const error = AsyncResult.isFailure(result) && !result.waiting ? failureText(result.cause, failure) : undefined;
  return (
    <>
      <SkipLink />
      <TopBar width="home" place={place}>
        {actions}
      </TopBar>
      <main id="main" tabIndex={-1} className={cn(frame({ width: "home" }), "pt-8 pb-12")}>
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
      </main>
      <footer className={cn(frame({ width: "home" }), "mb-8")}>
        <ThemeControl />
      </footer>
    </>
  );
};
