/** A count a reader scans: an icon and a number, with the sentence it stands for in the title and the label. */
import { cva, type VariantProps } from "class-variance-authority";
import type { LucideIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn.ts";

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
    readonly title: string;
    readonly children?: ReactNode;
  };

export const Stat = ({ icon: Icon, tone, title, className, children, ...props }: StatProps) => (
  <span role="img" aria-label={title} title={title} className={cn(statVariants({ tone }), className)} {...props}>
    <Icon aria-hidden="true" className="size-3.5 shrink-0" />
    {children}
  </span>
);
