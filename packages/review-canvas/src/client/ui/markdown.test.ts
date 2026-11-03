// Comment bodies as Markdown: what renders, and what a body's raw HTML, images, and links can never do.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type MarkdownNode, markdownTree, safeHref } from "./markdown.ts";

/** A tree as compact text, `tag(children)`, so a test reads what the page will show. */
const show = (nodes: ReadonlyArray<MarkdownNode>): string =>
  nodes
    .map((node) => {
      switch (node.kind) {
        case "text":
          return JSON.stringify(node.text);
        case "element":
          return `${node.tag}(${show(node.children)})`;
        case "ordered":
          return `ol${node.start}(${show(node.children)})`;
        case "cell":
          return `${node.header ? "th" : "td"}${node.align === undefined ? "" : `:${node.align}`}(${show(node.children)})`;
        case "codeblock":
          return `pre(${JSON.stringify(node.text)})`;
        case "link":
          return `a[${node.href}](${show(node.children)})`;
        case "image":
          return `image[${node.href}](${JSON.stringify(node.alt)})`;
      }
    })
    .join(" ");

test("Markdown renders: emphasis, code, lists, quotes, and line breaks as GitHub shows comments", () => {
  assert.equal(
    show(
      markdownTree("**Fix** the `retry`\nloop.\n\n- one\n- two\n\n> quoted"),
    ),
    'p(strong("Fix") " the " code("retry") br() "loop.") ul(li("one") li("two")) blockquote(p("quoted"))',
  );
  assert.equal(
    show(markdownTree("3. three\n4. four")),
    'ol3(li("three") li("four"))',
  );
  assert.equal(
    show(markdownTree("```ts\nconst a = 1;\n```")),
    'pre("const a = 1;\\n")',
  );
  assert.equal(
    show(markdownTree("| a | b |\n|:-|-:|\n| 1 | 2 |")),
    'table(thead(tr(th:left("a") th:right("b"))) tbody(tr(td:left("1") td:right("2"))))',
  );
  assert.equal(
    show(markdownTree("### Codex Review")),
    'heading("Codex Review")',
  );
});

test("a bot's review summary: HTML comments go, a details block discloses its Markdown, a badge is a link", () => {
  const body = [
    "<!-- codex: internal marker -->",
    "**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange)</sub></sub>  Guard the lock**",
    "",
    "<details> <summary>About Codex in GitHub</summary>",
    "<br/>",
    "",
    "Reviews are triggered when you [open a PR](https://chatgpt.com/codex).",
    "</details>",
  ].join("\n");
  assert.equal(
    show(markdownTree(body)),
    [
      'p(strong(sub(sub(image[https://img.shields.io/badge/P1-orange]("P1 Badge"))) "  Guard the lock"))',
      'details(summary("About Codex in GitHub") br()',
      'p("Reviews are triggered when you " a[https://chatgpt.com/codex]("open a PR") "."))',
    ].join(" "),
  );
});

test("raw HTML never becomes markup: scripts and their text go, other tags lose their attributes, unknown names stay text", () => {
  assert.equal(
    show(markdownTree('<script>alert("x")</script>\n\nSafe.')),
    'p("Safe.")',
  );
  assert.equal(
    show(
      markdownTree(
        'Click <a href="javascript:alert(1)">here</a> or <b onclick="x()">there</b>.',
      ),
    ),
    'p("Click here or " strong("there") ".")',
  );
  // In an HTML block, other elements go and their text stays.
  assert.equal(
    show(
      markdownTree(
        '<div align="center"><span style="color:red">Hi</span></div>',
      ),
    ),
    '"Hi"',
  );
  // In running text, a tag is text: it never runs, and prose that names one keeps it.
  assert.equal(
    show(markdownTree("The page escapes <script> and <style> here.")),
    'p("The page escapes <script> and <style> here.")',
  );
  // An image tag is a link to the image, which nothing loads.
  assert.equal(
    show(markdownTree('<img src="https://example.com/x.png" alt="chart">')),
    'image[https://example.com/x.png]("chart")',
  );
  // Generics are not HTML.
  assert.equal(
    show(markdownTree("Returns Promise<void> from List<T>.")),
    'p("Returns Promise<void> from List<T>.")',
  );
  // A disclosure inside a paragraph is not one: block tags come only from HTML blocks.
  assert.equal(
    show(markdownTree("Text <details>inline</details> end")),
    'p("Text <details>inline</details> end")',
  );
  // A tag left open closes with its block.
  assert.equal(show(markdownTree("a <sub>b\n\nc")), 'p("a " sub("b")) p("c")');
});

test("an element dropped with its content but never closed drops only its tag, and the rest of the body shows", () => {
  // The Markdown after an unclosed frame is its own block, and shows as ever.
  assert.equal(
    show(
      markdownTree(
        '<iframe src="https://x">\n\nThis PR drops the users table.\n\nMore text',
      ),
    ),
    'p("This PR drops the users table.") p("More text")',
  );
  // An unclosed textarea's HTML block runs to the end of the body: its text shows, as GitHub shows it.
  assert.equal(
    show(markdownTree("<textarea>\n\nhidden after\n\n- item")),
    '"\\n\\nhidden after\\n\\n- item"',
  );
  // A closed one still goes with its content, and only up to its end tag.
  assert.equal(
    show(markdownTree("<svg>\n<text>logo</text>\n</svg>\nafter\n\nNext")),
    '"\\nafter\\n" p("Next")',
  );
  // An end tag in a later block closes nothing: the text between shows.
  assert.equal(
    show(markdownTree("<object>\nfallback\n\nMiddle\n\n</object>\n\nEnd")),
    '"\\nfallback\\n" p("Middle") p("End")',
  );
});

test("links go only to web and mail addresses, and bare addresses link", () => {
  assert.equal(
    show(
      markdownTree("[x](javascript:alert(1)) [y](/local) [z](mailto:a@b.c)"),
    ),
    'p("[x](javascript:alert(1)) y " a[mailto:a@b.c]("z"))',
  );
  assert.equal(
    show(markdownTree("See https://example.com/a for more.")),
    'p("See " a[https://example.com/a]("https://example.com/a") " for more.")',
  );
  assert.equal(safeHref("data:text/html,x"), undefined);
  assert.equal(safeHref("http://localhost/x"), "http://localhost/x");
  assert.equal(
    show(markdownTree("![tracker](data:image/png;base64,AAAA)")),
    'p("tracker")',
  );
});

test("plain text stays as written", () => {
  assert.equal(
    show(markdownTree("Why mkstemp here?\nSame filesystem &amp; all.")),
    'p("Why mkstemp here?" br() "Same filesystem & all.")',
  );
  assert.deepEqual(markdownTree(""), []);
});
