import type { ComponentProps } from "react";
import { cn } from "./cn.ts";

/** Every text box the reviewer writes in: a comment, a reply, or a finish's summary. */
export const Textarea = ({ className, ...props }: ComponentProps<"textarea">) => (
  <textarea
    className={cn(
      "block w-full max-w-reading resize-y rounded-control border border-line bg-code px-3 py-2 text-base placeholder:text-muted",
      className,
    )}
    {...props}
  />
);
