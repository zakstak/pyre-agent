/**
 * Comment bodies as Markdown, the way GitHub shows them, made safe by construction: markdown-it reads the text into
 * tokens, and this turns the tokens into a tree of the few elements a body may show. The page renders the tree with
 * React and never injects markup. Of raw HTML, a short list of formatting tags, such as `<details>` and `<sub>`,
 * become their elements without their attributes; an HTML block's other tags go and their text stays, as GitHub
 * shows them, and its scripts and styles go with their content up to their end tag in the same block; HTML comments
 * are dropped; in running text any other tag is text. An image is a link to it: nothing remote loads by itself. Links
 * go only to web and mail addresses.
 */
import MarkdownIt from "markdown-it";
import type { Token } from "markdown-it";

/** The elements a body may show, beside text, code, links, images, ordered lists, and table cells. */
export type MarkdownTag =
  | "p"
  | "heading"
  | "blockquote"
  | "ul"
  | "li"
  | "hr"
  | "br"
  | "table"
  | "thead"
  | "tbody"
  | "tr"
  | "details"
  | "summary"
  | "em"
  | "strong"
  | "s"
  | "ins"
  | "sub"
  | "sup"
  | "kbd"
  | "code";

export type Align = "left" | "center" | "right";

export type MarkdownNode =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "element";
      readonly tag: MarkdownTag;
      readonly children: ReadonlyArray<MarkdownNode>;
    }
  | {
      readonly kind: "ordered";
      readonly start: number;
      readonly children: ReadonlyArray<MarkdownNode>;
    }
  | {
      readonly kind: "cell";
      readonly header: boolean;
      readonly align: Align | undefined;
      readonly children: ReadonlyArray<MarkdownNode>;
    }
  | { readonly kind: "codeblock"; readonly text: string }
  | {
      readonly kind: "link";
      readonly href: string;
      readonly children: ReadonlyArray<MarkdownNode>;
    }
  /** An image, shown as a link to it with its description, so a remote image never loads by itself. */
  | { readonly kind: "image"; readonly href: string; readonly alt: string };

// Typographic replacements stay off: the body's own characters show. Raw HTML is read so the tags below can be
// recognized; none of it is rendered as markup.
const md = new MarkdownIt({ html: true, linkify: true, typographer: false });

/** Only web and mail addresses: a body's relative link would point into this server, and other schemes can run code. */
export const safeHref = (href: string): string | undefined => {
  try {
    const url = new URL(href);
    return url.protocol === "https:" ||
      url.protocol === "http:" ||
      url.protocol === "mailto:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
};

/** HTML tags a body may use, by name, as the elements they become. */
const HTML_TAGS: Readonly<Record<string, MarkdownTag>> = {
  details: "details",
  summary: "summary",
  p: "p",
  blockquote: "blockquote",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  b: "strong",
  strong: "strong",
  i: "em",
  em: "em",
  s: "s",
  del: "s",
  strike: "s",
  ins: "ins",
  sub: "sub",
  sup: "sup",
  kbd: "kbd",
  code: "code",
};

const BLOCK_TAGS: ReadonlySet<MarkdownTag> = new Set([
  "details",
  "summary",
  "p",
  "blockquote",
  "heading",
]);

const VOID_TAGS: Readonly<Record<string, MarkdownTag>> = { br: "br", hr: "hr" };

/** HTML elements whose content is no text to read: they go with everything in them. */
const DROPPED_WITH_CONTENT = new Set([
  "script",
  "style",
  "template",
  "textarea",
  "title",
  "iframe",
  "object",
  "svg",
  "math",
  "noscript",
]);

/** Other HTML elements, which an HTML block's text keeps without them, as GitHub does. */
const KNOWN_TAGS = new Set([
  "a",
  "abbr",
  "address",
  "area",
  "article",
  "aside",
  "audio",
  "base",
  "bdi",
  "bdo",
  "big",
  "body",
  "button",
  "canvas",
  "caption",
  "center",
  "cite",
  "col",
  "colgroup",
  "data",
  "datalist",
  "dd",
  "dfn",
  "dialog",
  "div",
  "dl",
  "dt",
  "embed",
  "fieldset",
  "figcaption",
  "figure",
  "font",
  "footer",
  "form",
  "head",
  "header",
  "html",
  "img",
  "input",
  "label",
  "legend",
  "li",
  "link",
  "main",
  "map",
  "mark",
  "meta",
  "meter",
  "nav",
  "ol",
  "optgroup",
  "option",
  "output",
  "param",
  "picture",
  "pre",
  "progress",
  "q",
  "rp",
  "rt",
  "ruby",
  "samp",
  "section",
  "select",
  "small",
  "source",
  "span",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "track",
  "tt",
  "u",
  "ul",
  "var",
  "video",
  "wbr",
]);

/** Comments, CDATA, declarations, processing instructions, and tags, as CommonMark's raw HTML has them. */
const HTML_PIECE =
  /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![A-Za-z][^>]*>?|<\?[\s\S]*?(?:\?>|$)|<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

const attribute = (attributes: string, name: string): string | undefined => {
  const match = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`,
    "i",
  ).exec(attributes);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? undefined : md.utils.unescapeAll(value);
};

/** Where a frame came from, so the token or tag that closes it finds it. */
type Opener =
  | { readonly kind: "root" }
  | { readonly kind: "markdown"; readonly type: string }
  | { readonly kind: "html"; readonly name: string };

/** A node being built, with the children found so far. A transparent frame hands its children to its parent. */
interface Frame {
  readonly opener: Opener;
  readonly make:
    | ((children: ReadonlyArray<MarkdownNode>) => MarkdownNode)
    | undefined;
  readonly children: Array<MarkdownNode>;
}

const element =
  (tag: MarkdownTag) =>
  (children: ReadonlyArray<MarkdownNode>): MarkdownNode => ({
    kind: "element",
    tag,
    children,
  });

const ALIGN = /text-align:\s*(left|center|right)/;

/** The frame a Markdown token opens, or undefined for one that shows only its children, as a tight list's paragraph. */
const opens = (
  token: Token,
): ((children: ReadonlyArray<MarkdownNode>) => MarkdownNode) | undefined => {
  switch (token.type) {
    case "paragraph_open":
      return token.hidden ? undefined : element("p");
    case "heading_open":
      return element("heading");
    case "blockquote_open":
      return element("blockquote");
    case "bullet_list_open":
      return element("ul");
    case "ordered_list_open": {
      const start = Number(token.attrGet("start") ?? 1);
      return (children) => ({
        kind: "ordered",
        start: Number.isSafeInteger(start) ? start : 1,
        children,
      });
    }
    case "list_item_open":
      return element("li");
    case "table_open":
      return element("table");
    case "thead_open":
      return element("thead");
    case "tbody_open":
      return element("tbody");
    case "tr_open":
      return element("tr");
    case "th_open":
    case "td_open": {
      const align = ALIGN.exec(String(token.attrGet("style") ?? ""))?.[1];
      const header = token.type === "th_open";
      return (children) => ({
        kind: "cell",
        header,
        align:
          align === "left" || align === "center" || align === "right"
            ? align
            : undefined,
        children,
      });
    }
    case "em_open":
      return element("em");
    case "strong_open":
      return element("strong");
    case "s_open":
      return element("s");
    case "link_open": {
      const href = safeHref(String(token.attrGet("href") ?? ""));
      return href === undefined
        ? undefined
        : (children) => ({ kind: "link", href, children });
    }
    default:
      return undefined;
  }
};

/** A builder of the tree: a stack of open frames over the root's. */
class Builder {
  readonly #stack: Array<Frame> = [
    { opener: { kind: "root" }, make: undefined, children: [] },
  ];

  get #top(): Frame {
    const top = this.#stack.at(-1);
    if (top === undefined) throw new Error("the root frame is never closed");
    return top;
  }

  add(node: MarkdownNode) {
    if (node.kind === "text") {
      const last = this.#top.children.at(-1);
      if (last?.kind === "text") {
        this.#top.children[this.#top.children.length - 1] = {
          kind: "text",
          text: last.text + node.text,
        };
        return;
      }
      if (node.text === "") return;
    }
    this.#top.children.push(node);
  }

  open(
    opener: Opener,
    make: ((children: ReadonlyArray<MarkdownNode>) => MarkdownNode) | undefined,
  ) {
    this.#stack.push({ opener, make, children: [] });
  }

  #pop() {
    const frame = this.#stack.pop();
    if (frame === undefined || this.#stack.length === 0)
      throw new Error("the root frame is never closed");
    if (frame.make === undefined)
      for (const child of frame.children) this.add(child);
    else this.add(frame.make(frame.children));
  }

  /** Closes the frame a Markdown token opened, and every HTML frame left open inside it. */
  closeMarkdown(type: string) {
    const at = this.#stack.findLastIndex(
      (frame) => frame.opener.kind === "markdown" && frame.opener.type === type,
    );
    if (at <= 0) return;
    while (this.#stack.length > at) this.#pop();
  }

  /**
   * Closes the HTML element of that name opened since the nearest Markdown block, and those opened inside it. A close
   * with nothing to close is dropped.
   */
  #closeHtml(name: string) {
    for (let at = this.#stack.length - 1; at > 0; at--) {
      const opener = this.#stack[at]?.opener;
      if (opener?.kind !== "html") return;
      if (opener.name !== name) continue;
      while (this.#stack.length > at) this.#pop();
      return;
    }
  }

  /**
   * Raw HTML from a block or inline token: its formatting tags as elements, its text as text, the rest dropped. What
   * goes with an element's content ends with the token: an element whose end tag the token does not hold drops only
   * its tag, so nothing after the token, such as the Markdown below an unclosed `<iframe>`, can vanish with it.
   */
  html(source: string, block: boolean) {
    // Between the tags of an HTML block, white space alone lays nothing out.
    const text = (raw: string) => {
      if (!block || raw.trim() !== "")
        this.add({ kind: "text", text: md.utils.unescapeAll(raw) });
    };
    // Inside an element dropped with its content: the name of its end tag, which this token holds.
    let skipping: string | undefined;
    let at = 0;
    for (const match of source.matchAll(HTML_PIECE)) {
      if (skipping === undefined) text(source.slice(at, match.index));
      at = match.index + match[0].length;
      const name = match[2]?.toLowerCase();
      if (name === undefined) continue;
      const closing = match[1] === "/";
      if (skipping !== undefined) {
        if (closing && name === skipping) skipping = undefined;
        continue;
      }
      const attributes = match[3] ?? "";
      const lone = VOID_TAGS[name];
      if (lone !== undefined) {
        if (!closing && (block || lone === "br"))
          this.add({ kind: "element", tag: lone, children: [] });
        continue;
      }
      if (name === "img") {
        const href = safeHref(attribute(attributes, "src") ?? "");
        if (href !== undefined && !closing)
          this.add({
            kind: "image",
            href,
            alt: attribute(attributes, "alt") ?? "",
          });
        continue;
      }
      if (name === "a") {
        if (closing) this.#closeHtml("a");
        else {
          const href = safeHref(attribute(attributes, "href") ?? "");
          this.open(
            { kind: "html", name: "a" },
            href === undefined
              ? undefined
              : (children) => ({ kind: "link", href, children }),
          );
        }
        continue;
      }
      // Block elements come only from raw HTML blocks: a paragraph holds no disclosure.
      const tag = HTML_TAGS[name];
      if (tag !== undefined && (block || !BLOCK_TAGS.has(tag))) {
        if (closing) this.#closeHtml(name);
        else this.open({ kind: "html", name }, element(tag));
        continue;
      }
      // In an HTML block, other elements go and their text stays, as GitHub shows them; a script or a style goes
      // with its content.
      if (block && DROPPED_WITH_CONTENT.has(name)) {
        if (
          !closing &&
          !/\/\s*$/.test(attributes) &&
          new RegExp(`</${name}\\s*>`, "i").test(source.slice(at))
        )
          skipping = name;
        continue;
      }
      if (block && KNOWN_TAGS.has(name)) continue;
      // In running text a tag is text, as `<script>` in "escape <script>" or `<T>` in `List<T>`: it never runs.
      this.add({ kind: "text", text: match[0] });
    }
    if (skipping === undefined) text(source.slice(at));
  }

  /** The tree, with every frame still open closed. */
  done(): ReadonlyArray<MarkdownNode> {
    while (this.#stack.length > 1) this.#pop();
    return this.#stack[0]?.children ?? [];
  }
}

const inline = (builder: Builder, tokens: ReadonlyArray<Token>) => {
  for (const token of tokens) {
    switch (token.type) {
      case "text":
        builder.add({ kind: "text", text: token.content });
        break;
      // A line break in a comment is a line break, as GitHub shows comments.
      case "softbreak":
      case "hardbreak":
        builder.add({ kind: "element", tag: "br", children: [] });
        break;
      case "code_inline":
        builder.add({
          kind: "element",
          tag: "code",
          children: [{ kind: "text", text: token.content }],
        });
        break;
      case "image": {
        const href = safeHref(String(token.attrGet("src") ?? ""));
        const alt = token.content;
        builder.add(
          href === undefined
            ? { kind: "text", text: alt }
            : { kind: "image", href, alt },
        );
        break;
      }
      case "html_inline":
        builder.html(token.content, false);
        break;
      default:
        if (token.nesting === 1)
          builder.open({ kind: "markdown", type: token.type }, opens(token));
        else if (token.nesting === -1)
          builder.closeMarkdown(token.type.replace(/_close$/, "_open"));
        else if (token.content !== "")
          builder.add({ kind: "text", text: token.content });
    }
  }
};

/** A comment body as the tree of what it shows. */
export const markdownTree = (source: string): ReadonlyArray<MarkdownNode> => {
  const builder = new Builder();
  for (const token of md.parse(source, {})) {
    switch (token.type) {
      case "inline":
        inline(builder, token.children ?? []);
        break;
      case "fence":
      case "code_block":
        builder.add({ kind: "codeblock", text: token.content });
        break;
      case "hr":
        builder.add({ kind: "element", tag: "hr", children: [] });
        break;
      case "html_block":
        builder.html(token.content, true);
        break;
      default:
        if (token.nesting === 1)
          builder.open({ kind: "markdown", type: token.type }, opens(token));
        else if (token.nesting === -1)
          builder.closeMarkdown(token.type.replace(/_close$/, "_open"));
    }
  }
  return builder.done();
};
