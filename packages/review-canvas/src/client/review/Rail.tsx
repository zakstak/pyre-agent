/**
 * The column beside the review: the contents in the guided view, the guide in the source view. A wide page keeps it
 * beside the review, sticky and as tall as the viewport, with a list that scrolls on its own and a foot pinned under
 * it; a narrower page folds it into a disclosure above the review, which the caller closes when a row is picked.
 */
import type { ComponentProps, ReactNode, RefObject } from "react";
import { cn } from "../ui/cn.ts";

export const Rail = ({
  wide,
  open,
  onOpen,
  summary,
  head,
  foot,
  scroller,
  className,
  children,
  ...props
}: Omit<ComponentProps<"div">, "children"> & {
  readonly wide: boolean;
  /** Whether the disclosure is open, on a narrow page. */
  readonly open: boolean;
  readonly onOpen: (open: boolean) => void;
  /** What the disclosure says. */
  readonly summary: ReactNode;
  /** A control over the list, such as the guide's tabs. */
  readonly head?: ReactNode;
  /** What sits under the list: the diff choices. */
  readonly foot?: ReactNode;
  /** The list's scroller on a wide page, which `keepInRail` scrolls without moving the page. */
  readonly scroller?: RefObject<HTMLDivElement | null>;
  readonly children: ReactNode;
}) => (
  <div
    {...props}
    className={cn(
      "min-w-0 lg:sticky lg:top-(--sticky-top) lg:flex lg:h-[calc(100vh-var(--sticky-top))] lg:flex-col lg:self-start lg:pt-6",
      className,
    )}
  >
    {wide ? (
      <>
        {head}
        <div ref={scroller} data-rail-scroll className={cn("min-h-0 flex-1 overflow-y-auto", head === undefined || "mt-3")}>
          {children}
        </div>
        {foot}
      </>
    ) : (
      <details open={open} onToggle={(event) => onOpen(event.currentTarget.open)} className="mt-4 rounded-panel bg-surface px-3">
        <summary className="flex min-h-11 items-center font-semibold">{summary}</summary>
        <div className="pb-3">
          {head}
          <div className={head === undefined ? undefined : "mt-3"}>{children}</div>
          {foot}
        </div>
      </details>
    )}
  </div>
);
