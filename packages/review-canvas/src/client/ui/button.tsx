import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./cn.ts";

/**
 * A 44px target on touch screens for a control drawn smaller, through an invisible ::after box, so dense rows keep
 * their look. Every compact control uses it, whether or not it is a `Button`.
 */
export const TOUCH_TARGET =
  "relative pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:top-1/2 pointer-coarse:after:min-h-11 pointer-coarse:after:-translate-y-1/2";

/**
 * Every button on the page. Small buttons keep a dense row's look and reach a 44px target on touch screens through
 * an invisible ::after box.
 */
export const buttonVariants = cva(
  [
    "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap",
    "rounded-control border font-semibold leading-tight no-underline transition-colors",
    "disabled:cursor-not-allowed disabled:border-separator disabled:bg-surface disabled:text-muted",
    TOUCH_TARGET,
  ],
  {
    variants: {
      variant: {
        default: "border-line bg-raised text-ink hover:bg-subtle",
        primary: "border-action bg-action text-on-action hover:brightness-110",
        quiet: "border-transparent bg-transparent text-ink hover:bg-subtle",
      },
      size: {
        default: "min-h-11 px-4 py-2 text-base",
        sm: "h-7 px-2.5 text-small font-medium",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export type ButtonProps = ComponentProps<"button"> & VariantProps<typeof buttonVariants>;

export const Button = ({ className, variant, size, type = "button", ...props }: ButtonProps) => (
  <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
);
