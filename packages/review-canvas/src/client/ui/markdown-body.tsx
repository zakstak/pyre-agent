/**
 * A comment body as Markdown: the tree markdown.ts reads it into, drawn with React elements and the theme's
 * utilities. Nothing here sets markup from the body; React escapes every text. Links open in a new tab without the
 * page as their opener, and an image shows as a link to it.
 */
import { cva } from "class-variance-authority";
import { ImageIcon } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { cn } from "./cn.ts";
import {
  type MarkdownNode,
  type MarkdownTag,
  markdownTree,
} from "./markdown.ts";

const LINK = "text-link underline underline-offset-3 break-words";

const cell = cva("border border-separator px-2 py-1 align-top", {
  variants: {
    header: { true: "bg-surface font-semibold", false: "" },
    align: {
      left: "text-left",
      center: "text-center",
      right: "text-right",
      none: "text-left",
    },
  },
});

/** How each element looks. Headings in a comment are bold lines, so the page's own outline stays the stops and files. */
const ELEMENT: Readonly<
  Record<MarkdownTag, (key: number, children: ReactNode) => ReactNode>
> = {
  p: (key, children) => <p key={key}>{children}</p>,
  heading: (key, children) => (
    <p key={key} className="font-semibold">
      {children}
    </p>
  ),
  blockquote: (key, children) => (
    <blockquote
      key={key}
      className="border-l-2 border-separator pl-3 text-muted [&>*+*]:mt-2"
    >
      {children}
    </blockquote>
  ),
  ul: (key, children) => (
    <ul key={key} className="list-disc pl-6">
      {children}
    </ul>
  ),
  li: (key, children) => (
    <li key={key} className="[&>*+*]:mt-1">
      {children}
    </li>
  ),
  hr: (key) => <hr key={key} className="border-separator" />,
  br: (key) => <br key={key} />,
  table: (key, children) => (
    <div key={key} className="overflow-x-auto">
      <table className="border-collapse text-small">{children}</table>
    </div>
  ),
  thead: (key, children) => <thead key={key}>{children}</thead>,
  tbody: (key, children) => <tbody key={key}>{children}</tbody>,
  tr: (key, children) => <tr key={key}>{children}</tr>,
  details: (key, children) => (
    <details
      key={key}
      className="rounded-control border border-separator px-3 py-1 [&>*+*]:mt-2"
    >
      {children}
    </details>
  ),
  summary: (key, children) => (
    <summary key={key} className="cursor-pointer font-semibold">
      {children}
    </summary>
  ),
  em: (key, children) => <em key={key}>{children}</em>,
  strong: (key, children) => (
    <strong key={key} className="font-semibold">
      {children}
    </strong>
  ),
  s: (key, children) => <s key={key}>{children}</s>,
  ins: (key, children) => <ins key={key}>{children}</ins>,
  sub: (key, children) => <sub key={key}>{children}</sub>,
  sup: (key, children) => <sup key={key}>{children}</sup>,
  kbd: (key, children) => (
    <kbd
      key={key}
      className="rounded-control border border-line bg-raised px-1"
    >
      {children}
    </kbd>
  ),
  code: (key, children) => (
    <code key={key} className="rounded-control bg-code px-1 py-px">
      {children}
    </code>
  ),
};

const nodes = (list: ReadonlyArray<MarkdownNode>): ReactNode =>
  list.map((node, key) => {
    switch (node.kind) {
      case "text":
        return node.text;
      case "element":
        return ELEMENT[node.tag](key, nodes(node.children));
      case "ordered":
        return (
          <ol key={key} start={node.start} className="list-decimal pl-6">
            {nodes(node.children)}
          </ol>
        );
      case "cell": {
        const Cell = node.header ? "th" : "td";
        return (
          <Cell
            key={key}
            className={cell({
              header: node.header,
              align: node.align ?? "none",
            })}
          >
            {nodes(node.children)}
          </Cell>
        );
      }
      case "codeblock":
        return (
          <pre
            key={key}
            className="overflow-x-auto rounded-control bg-code px-3 py-2 text-technical"
          >
            <code>{node.text}</code>
          </pre>
        );
      case "link":
        return (
          <a
            key={key}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className={LINK}
          >
            {nodes(node.children)}
          </a>
        );
      case "image":
        return (
          <a
            key={key}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            data-image
            title={`Image, not loaded: ${node.href}`}
            className={cn(LINK, "inline-flex items-baseline gap-1")}
          >
            <ImageIcon
              aria-hidden="true"
              className="size-3.5 self-center text-muted"
            />
            {node.alt.trim() === "" ? "image" : node.alt}
          </a>
        );
    }
  });

/** A comment body, read as Markdown. An empty body shows nothing. */
export const MarkdownBody = ({
  text,
  className,
}: {
  readonly text: string;
  readonly className?: string | undefined;
}) => {
  const tree = useMemo(() => markdownTree(text), [text]);
  if (tree.length === 0) return null;
  return (
    <div
      data-markdown
      className={cn("mt-1 break-words text-ink [&>*+*]:mt-2", className)}
    >
      {nodes(tree)}
    </div>
  );
};
