import type { Assets } from "../assets.ts";
import { type Html, html } from "../html.ts";

export const themeToggle = html`<button type="button" id="theme-toggle" class="theme-toggle quiet" aria-pressed="false" hidden><span class="theme-label">Dark mode</span></button>`;

/** The document every page shares: its head, assets, app bar, and theme. */
export const page = (
  assets: Assets["Service"],
  options: {
    readonly title: string;
    readonly topbar: Html;
    readonly body: Html;
    readonly bodyClass?: string | undefined;
    /** Data the client script reads, as attributes of the body. */
    readonly data?: Readonly<Record<string, string>> | undefined;
  },
) =>
  html`<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${options.title}</title>
${assets.styles.map((href) => html`<link rel="stylesheet" href="${href}">`)}
${assets.scripts.map((src) => html`<script type="module" src="${src}"></script>`)}
</head>
<body class="${options.bodyClass ?? ""}"${Object.entries(options.data ?? {}).map(([key, value]) => html` data-${key}="${value}"`)}>
<a class="skip-link" href="#main">Skip to content</a>
<header class="topbar">${options.topbar}</header>
${options.body}
</body>
</html>`;
