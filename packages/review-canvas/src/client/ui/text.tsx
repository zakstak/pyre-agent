/** Text from the agents and times, as the pages show them. React escapes the text; nothing here is markup. */
import { Fragment } from "react";
import { cn } from "./cn.ts";

/** Text with each `code` span between single backticks on one line shown as code. A lone backtick stays one. */
export const Inline = ({ text }: { readonly text: string }) => {
  const parts: Array<React.ReactNode> = [];
  let at = 0;
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    parts.push(text.slice(at, match.index), <code key={match.index}>{match[1]}</code>);
    at = match.index + match[0].length;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
};

/** Prose from the agent: paragraphs split on blank lines, each keeping its line breaks and code spans. */
export const Prose = ({ text, className }: { readonly text: string; readonly className?: string }) => (
  <>
    {text
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => paragraph !== "")
      .map((paragraph, at) => (
        <p key={at} className={cn("max-w-reading whitespace-pre-line [&+&]:mt-2", className)}>
          <Inline text={paragraph} />
        </p>
      ))}
  </>
);

/** A title that reads as a sentence lead: with a full stop unless it already ends in punctuation. */
export const Lead = ({ title }: { readonly title: string }) => (
  <>
    <Inline text={title} />
    {/[.!?:…]$/.test(title.trim()) ? null : "."}
  </>
);

const clock = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const full = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** A time on the reader's clock: the time alone today, the day and time this year, the full date otherwise. */
export const Time = ({ at }: { readonly at: string }) => {
  const when = new Date(at);
  if (!Number.isFinite(when.getTime())) return <time dateTime={at}>{at}</time>;
  const now = new Date();
  const format =
    when.toDateString() === now.toDateString() ? clock : when.getFullYear() === now.getFullYear() ? day : full;
  return (
    <time dateTime={at} title={full.format(when)}>
      {format.format(when)}
    </time>
  );
};

/** A list joined with commas, as in running text. */
export const Joined = ({ items }: { readonly items: ReadonlyArray<React.ReactNode> }) => (
  <>
    {items.map((item, at) => (
      <Fragment key={at}>
        {at === 0 ? null : ", "}
        {item}
      </Fragment>
    ))}
  </>
);
