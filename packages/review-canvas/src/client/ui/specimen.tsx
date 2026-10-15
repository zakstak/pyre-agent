/**
 * A sample of the review page, for the appearance settings: the next strip, then a file block with a diff, a note, and
 * a thread, drawn with the review page's own classes. It draws in whatever palette and mode its ancestors set, so a
 * palette can be seen on the things it colours before it is chosen.
 */
import { ArrowRight, Check } from "lucide-react";
import type { ComponentProps } from "react";
import { buttonVariants } from "./button.tsx";
import { cn } from "./cn.ts";
import { LineCounts } from "./text.tsx";
import { Voice } from "./voice.tsx";

type Kind = "hunk" | "context" | "del" | "add";

const ROW_TONE: Readonly<Record<Kind, string>> = { hunk: "bg-surface text-muted", context: "", del: "bg-diff-deletion", add: "bg-diff-addition" };
const MARK: Readonly<Record<Kind, string>> = { hunk: "", context: " ", del: "−", add: "+" };
const MARK_TONE: Readonly<Record<Kind, string>> = { hunk: "", context: "", del: "font-semibold text-danger", add: "font-semibold text-success" };

const Row = ({ kind, old, fresh, children }: { readonly kind: Kind; readonly old?: number; readonly fresh?: number; readonly children: string }) => (
  <tr className={ROW_TONE[kind]}>
    <td className="w-px pr-1 pl-3 text-right text-muted">{old ?? ""}</td>
    <td className="w-px pr-1 pl-1 text-right text-muted">{fresh ?? ""}</td>
    <td className={cn("w-px px-1 text-center", MARK_TONE[kind])}>{MARK[kind]}</td>
    <td className={cn("pr-3 whitespace-pre", kind === "hunk" ? "text-muted" : "text-ink")}>{children}</td>
  </tr>
);

const Under = ({ className, children }: { readonly className?: string; readonly children: React.ReactNode }) => (
  <tr>
    <td colSpan={4} className={cn("bg-surface p-0 font-sans text-small whitespace-normal", className)}>
      {/* As on the review page: the text keeps to the visible width while the code rows scroll. */}
      <div className="sticky left-0 max-w-[100cqi] px-3 py-1.5 pl-11">{children}</div>
    </td>
  </tr>
);

const Chip = ({ tone, children }: { readonly tone: "action" | "success"; readonly children: string }) => (
  <span className={cn("inline-flex items-center rounded-full border px-2 text-chip leading-5 font-semibold", tone === "action" ? "border-action text-action" : "border-success text-success")}>
    {children}
  </span>
);

export const Specimen = ({ className, ...props }: ComponentProps<"div">) => (
  <div {...props} role="img" aria-label="A sample of the review page" className={cn("min-w-0 rounded-panel bg-page p-3 text-ink", className)}>
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-control bg-raised px-3 py-1.5 text-small">
      <span className="inline-grid size-6 place-items-center rounded-control bg-accent text-on-accent">
        <ArrowRight className="size-3.5" />
      </span>
      <span className="font-semibold">
        Review <code className="font-semibold">src/webhooks/backoff.ts</code>
      </span>
      <span className="text-muted">· stop 1 · 2 files left</span>
      <span className="ml-auto inline-flex items-center gap-1 text-muted tabular-nums">
        <Check className="size-3.5 text-success" />
        4/15
      </span>
      <span className={buttonVariants({ variant: "primary", size: "sm" })}>Finish</span>
    </div>
    <div className="mt-3 overflow-hidden rounded-panel bg-surface">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-separator px-3 py-1.5 text-small">
        <code>
          <span className="text-muted">src/webhooks/</span>
          <span className="font-semibold">backoff.ts</span>
        </code>
        <span className="min-w-0 truncate text-muted">A floor of half the base</span>
        <span className="ml-auto flex items-center gap-3">
          <LineCounts additions={23} deletions={2} className="text-technical" />
          <span className="inline-flex h-7 items-center gap-1.5 rounded-control border border-line bg-raised px-2 font-medium">
            <span className="inline-grid size-3.5 place-items-center rounded-sm border border-line" />
            Viewed
          </span>
        </span>
      </div>
      <div className="@container overflow-x-auto bg-code">
        <table className="w-full border-collapse font-mono text-technical leading-6">
          <tbody>
            <Row kind="hunk">@@ -8,4 +8,6 @@ export const nextDelay</Row>
            <Row kind="context" old={8} fresh={8}>{"  const ceiling = policy.cap_ms;"}</Row>
            <Row kind="del" old={9}>{"  return Math.floor(random() * ceiling);"}</Row>
            <Row kind="add" fresh={9}>{"  const floor = Math.min(ceiling, policy.base_ms / 2);"}</Row>
            <Row kind="add" fresh={10}>{"  return Math.floor(floor + random() * (ceiling - floor));"}</Row>
            <Under className="border-l-2 border-accent">
              <span className="mr-2 inline-grid size-4.5 place-items-center rounded-full bg-accent align-[0.0625rem] font-mono text-xs leading-none font-bold text-on-accent">
                A
              </span>
              <strong className="font-semibold">The floor.</strong> Half the base, or the ceiling when that is smaller.
            </Under>
            <Row kind="context" old={10} fresh={11}>{"};"}</Row>
            <Under>
              <div className="border-l-2 border-action py-1 pl-3">
                <p className="flex flex-wrap items-center gap-x-2 text-muted">
                  <Voice kind="you" name="You" />
                  <span>2:01 PM</span>
                  <Chip tone="action">Your turn</Chip>
                </p>
                <p className="mt-1 text-ink">A burst of 503s retries at once. Keep a floor of half the base.</p>
                <p className="mt-3 flex flex-wrap items-center gap-x-2 text-muted">
                  <Voice kind="agent" name="Claude Code" />
                  <Chip tone="success">Fixed</Chip>
                  <span>2:04 PM</span>
                </p>
                <p className="mt-1 text-ink">
                  nextDelay now returns at least half the base; the test fixes <code>random()</code> at 0.
                </p>
                <p className="mt-2 flex flex-wrap items-center gap-2">
                  <span className={buttonVariants({ size: "sm" })}>Accept</span>
                  <span className={buttonVariants({ variant: "quiet", size: "sm" })}>Reply</span>
                  <span className="ml-auto text-link underline underline-offset-3">Open on GitHub</span>
                </p>
              </div>
            </Under>
          </tbody>
        </table>
      </div>
    </div>
  </div>
);
