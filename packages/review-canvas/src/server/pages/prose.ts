/** Text from the agents, as the pages show it. */
import { type Html, html } from "../html.ts";

/**
 * Text from the agent, escaped, with each `code` span between single backticks on one line shown as code. A backtick
 * without a partner stays a backtick. Line breaks stay in the text; the page's styles keep them.
 */
export const inline = (text: string): Html => {
  const parts: Array<Html | string> = [];
  let at = 0;
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    parts.push(text.slice(at, match.index), html`<code>${match[1]}</code>`);
    at = match.index + match[0].length;
  }
  parts.push(text.slice(at));
  return html`${parts}`;
};

/** Prose from the agent: paragraphs split on blank lines, shown as text with its line breaks and code spans. */
export const prose = (text: string): Html =>
  html`${text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "")
    .map((paragraph) => html`<p class="prose">${inline(paragraph)}</p>`)}`;

/** A title that reads as a sentence lead: with a full stop unless it already ends in punctuation. */
export const lead = (title: string): Html =>
  /[.!?:…]$/.test(title.trim()) ? inline(title) : html`${inline(title)}.`;
