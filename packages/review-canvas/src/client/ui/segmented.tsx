/** A choice of one among a few, as joined buttons that each say whether they are the one pressed. */
import type { ReactNode } from "react";
import { TOUCH_TARGET } from "./button.tsx";
import { cn } from "./cn.ts";

/** The look of a pressed segment, and of any other control that shows a choice in force, such as a filter menu. */
export const PRESSED = "bg-selected text-ink shadow-pressed";

export const Segmented = <A extends string>({
  label,
  attribute,
  choices,
  value,
  onChange,
  className,
}: {
  /** The group's name, which a reader who hears the page hears. */
  readonly label: string;
  /** The data attribute each button carries its choice in, such as `data-layout`. */
  readonly attribute: `data-${string}`;
  readonly choices: ReadonlyArray<readonly [A, ReactNode]>;
  /** The choice pressed; none when the group has no choice in force. */
  readonly value: A | undefined;
  readonly onChange: (choice: A) => void;
  readonly className?: string;
}) => (
  <div
    role="group"
    aria-label={label}
    className={cn(
      "inline-flex h-7 overflow-hidden rounded-control border border-line text-small",
      className,
    )}
  >
    {choices.map(([choice, text]) => (
      <button
        key={choice}
        type="button"
        {...{ [attribute]: choice }}
        aria-pressed={value === choice}
        onClick={() => onChange(choice)}
        className={cn(
          TOUCH_TARGET,
          "px-2.5 font-medium",
          value === choice ? PRESSED : "bg-raised text-muted hover:bg-subtle",
        )}
      >
        {text}
      </button>
    ))}
  </div>
);
