/**
 * What every page has: the frame its contents align to, the skip link, and the message a page shows when it has
 * nothing else to show.
 */
import { cva } from "class-variance-authority";

/**
 * The one column a page's contents align to, centred with its gutters: the top bar's row, the body, and the footer.
 * A review is wide enough for the contents beside the diffs; the home page is a list.
 */
export const frame = cva("mx-auto px-6 max-md:px-4", {
  variants: { width: { review: "max-w-[96rem]", home: "max-w-[64rem]" } },
});

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
