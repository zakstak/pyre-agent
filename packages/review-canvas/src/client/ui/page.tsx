/**
 * What every page has: the frame its contents align to, the skip link, the top bar, and the message a page shows when
 * it has nothing else to show.
 */
import { useAtomValue } from "@effect/atom-react";
import { cva, type VariantProps } from "class-variance-authority";
import { useEffect, useRef } from "react";
import { CONNECTION_TEXT, connectionAtom } from "../rpc.ts";
import { cn } from "./cn.ts";
import { Time } from "./text.tsx";
import { toast } from "./toast.tsx";

/**
 * The one column a page's contents align to, centred with its gutters: the top bar's row, the body, and the footer.
 * A review is wide enough for the contents beside the diffs; the home page is a list.
 */
export const frame = cva("mx-auto px-6 max-md:px-4", {
  variants: { width: { review: "max-w-[96rem]", home: "max-w-[64rem]" } },
});

const LOST =
  "Lost connection to the review server. It stops after a long idle time; ask the agent to run any review-canvas command, such as review-canvas status, to start it again. This page reconnects on its own when the server returns on this port; otherwise open the URL that command prints.";

/** The connection state: quiet while connected, a live region that speaks when the socket is lost. */
const Connection = ({ updated }: { readonly updated: string | undefined }) => {
  const connection = useAtomValue(connectionAtom);
  const lost = CONNECTION_TEXT[connection.state];
  const said = useRef("");
  useEffect(() => {
    if (lost === CONNECTION_TEXT.disconnected && said.current !== lost) toast(LOST, "danger");
    said.current = lost;
  }, [lost]);
  return (
    <span className="text-small text-muted">
      {lost === "" && updated !== undefined ? (
        <span>
          Connected · updated <Time at={updated} />
        </span>
      ) : null}
      <span data-connection role="status" title={lost === "" ? undefined : LOST} className="font-semibold text-warning">
        {lost}
      </span>
    </span>
  );
};

/**
 * The bar over every page. On the left, `Review canvas`, then the page's place in it after a slash when it has one;
 * on the right, the connection state, then the page's own actions.
 */
export const TopBar = ({
  width,
  place,
  updated,
  controls,
  children,
}: {
  readonly width: NonNullable<VariantProps<typeof frame>["width"]>;
  /** Where the page is, after `Review canvas /`; absent on the home page, whose heading the name is. */
  readonly place?: React.ReactNode;
  readonly updated?: string | undefined;
  /** The page's own choices, before the connection state. */
  readonly controls?: React.ReactNode;
  readonly children?: React.ReactNode;
}) => (
  <header data-topbar className="z-20 border-b border-separator bg-surface text-small md:sticky md:top-0">
    <div className={cn(frame({ width }), "flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-1 md:min-h-11")}>
      <div className="flex min-w-0 flex-[1_1_12rem] flex-wrap items-baseline gap-x-2">
        {place === undefined ? (
          <h1 className="font-semibold">Review canvas</h1>
        ) : (
          <>
            <a href="/" className="text-muted underline underline-offset-3">
              Review canvas
            </a>
            <span aria-hidden="true" className="text-muted">
              /
            </span>
            {place}
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {controls}
        <Connection updated={updated} />
        {children}
      </div>
    </div>
  </header>
);

export const SkipLink = () => (
  <a
    href="#main"
    className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-control focus:border focus:border-line focus:bg-raised focus:px-3 focus:py-2"
  >
    Skip to content
  </a>
);

export const Message = ({ title, children }: { readonly title: string; readonly children?: React.ReactNode }) => (
  <main id="main" tabIndex={-1} className="mx-auto max-w-work p-8">
    <h1 className="text-title font-semibold">{title}</h1>
    {children === undefined ? null : <div className="mt-2 text-muted">{children}</div>}
    <p className="mt-4">
      <a className="text-link underline underline-offset-3" href="/">
        Back to the review canvas
      </a>
    </p>
  </main>
);
