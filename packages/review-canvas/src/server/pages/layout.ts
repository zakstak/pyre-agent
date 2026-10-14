import type { Assets } from "../assets.ts";
import { type Html, html } from "../html.ts";

/**
 * The page's one theme control, in the footer: the system's choice, or light or dark. The page script marks the
 * current choice and keeps it in the shared style's storage; without the script the page follows the system.
 */
export const themeControl = html`<span class="theme-control" role="group" aria-label="Theme">Theme: <button type="button" class="link-button" data-theme-choice="system" aria-pressed="true">system</button> · <button type="button" class="link-button" data-theme-choice="light" aria-pressed="false">light</button> · <button type="button" class="link-button" data-theme-choice="dark" aria-pressed="false">dark</button></span>`;

/**
 * The connection state, at the right of the top bar. The live region is empty while the page is connected, and says
 * "Reconnecting…" or "Disconnected" when the event stream is lost; the quiet "Connected" text shows only then.
 */
export const connection = (updated: Html): Html =>
  html`<span class="connection small muted"><span class="connected">Connected · updated ${updated}</span><span data-connection role="status"></span></span>`;

/** The document every page shares: its head, assets, top bar, and theme. */
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
<div class="toast" role="status" aria-live="polite" data-toast hidden></div>
</body>
</html>`;
