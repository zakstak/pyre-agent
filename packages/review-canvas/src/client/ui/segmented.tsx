/** A choice of one among a few, as joined buttons that each say whether they are the one pressed. */
import { TOUCH_TARGET } from "./button.tsx";
import { cn } from "./cn.ts";

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
  readonly choices: ReadonlyArray<readonly [A, string]>;
  readonly value: A;
  readonly onChange: (choice: A) => void;
  readonly className?: string;
}) => (
  <div role="group" aria-label={label} className={cn("inline-flex overflow-hidden rounded-control border border-line", className)}>
    {choices.map(([choice, text]) => (
      <button
        key={choice}
        type="button"
        {...{ [attribute]: choice }}
        aria-pressed={value === choice}
        onClick={() => onChange(choice)}
        className={cn(
          TOUCH_TARGET,
          "h-7 px-2.5 font-medium",
          value === choice ? "bg-selected text-ink shadow-pressed" : "bg-raised text-muted hover:bg-subtle",
        )}
      >
        {text}
      </button>
    ))}
  </div>
);
