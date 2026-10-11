import type { Assets } from "./assets.ts"
import { type Html, html } from "./html.ts"

/** The document every page shares: its head, assets, and theme. */
export const page = (assets: Assets["Service"], { title, body }: { readonly title: string; readonly body: Html }) =>
  html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${assets.styles.map((href) => html`<link rel="stylesheet" href="${href}">`)}
${assets.scripts.map((src) => html`<script type="module" src="${src}"></script>`)}
</head>
<body class="bg-page text-ink font-sans antialiased">${body}</body>
</html>`
