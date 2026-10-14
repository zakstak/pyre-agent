/** A count a reader scans: an icon and a number, with the sentence it stands for in the title and the label. */
import { cva, type VariantProps } from "class-variance-authority";
import type { LucideIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn.ts";
import { VoiceMark } from "./voice.tsx";

const statVariants = cva("inline-flex items-center gap-1 text-small tabular-nums", {
  variants: {
    tone: {
      ink: "text-ink",
      muted: "text-muted",
      action: "text-action",
      warning: "text-warning",
      success: "text-success",
      danger: "text-danger",
    },
  },
  defaultVariants: { tone: "muted" },
});

export type StatProps = Omit<ComponentProps<"span">, "title" | "children"> &
  VariantProps<typeof statVariants> & {
    readonly icon: LucideIcon;
    /** The icon's own colour, when it differs from the number's. */
    readonly iconClassName?: string | undefined;
    readonly title: string;
    readonly children?: ReactNode;
  };

export const Stat = ({ icon: Icon, iconClassName, tone, title, className, children, ...props }: StatProps) => (
  <span role="img" aria-label={title} title={title} className={cn(statVariants({ tone }), className)} {...props}>
    <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", iconClassName)} />
    {children}
  </span>
);

/** Answers that wait for the reviewer: the agent's voice mark and the count, in the action colour. */
export const AnswerStat = ({
  count,
  title,
  className,
  ...props
}: Omit<ComponentProps<"span">, "title" | "children"> & { readonly count: number; readonly title: string }) => (
  <span
    role="img"
    aria-label={title}
    title={title}
    className={cn("inline-flex items-center gap-1.5 text-small font-semibold text-action tabular-nums", className)}
    {...props}
  >
    <VoiceMark kind="agent" />
    {count}
  </span>
);
