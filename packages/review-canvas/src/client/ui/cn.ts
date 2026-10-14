import { type CxOptions, cx } from "class-variance-authority";
import { extendTailwindMerge } from "tailwind-merge";

// The theme's font sizes. Unregistered, tailwind-merge reads text-small as a colour and drops it beside text-muted.
const merge = extendTailwindMerge({
  extend: { theme: { text: ["title", "heading", "subheading", "reading", "small", "technical", "chip"] } },
});

/** Class names joined, with later Tailwind utilities winning over earlier ones that set the same property. */
export const cn = (...inputs: CxOptions): string => merge(cx(inputs));
