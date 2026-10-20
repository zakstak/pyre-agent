/**
 * Where this copy runs from. In a checkout, Node runs the TypeScript in src; an installed package runs the JavaScript
 * the build emits into dist/node, beside dist/client. Every chunk of the build lands in dist/node, so a path relative
 * to this module's URL works from any of them.
 */
import { fileURLToPath } from "node:url";

const fromSource = import.meta.url.endsWith(".ts");

export const codeDir = (): string =>
  fileURLToPath(new URL(fromSource ? "../" : "./", import.meta.url));

export const dependencyFile = (): string =>
  fileURLToPath(
    new URL(
      fromSource ? "../../pnpm-lock.yaml" : "../../package.json",
      import.meta.url,
    ),
  );

/** The built browser assets. */
export const clientDir = (): string =>
  fileURLToPath(
    new URL(fromSource ? "../../dist/client" : "../client", import.meta.url),
  );

/** The server's entry, which the command starts in the background. */
export const serverEntry = (): string =>
  fileURLToPath(
    new URL(fromSource ? "./main.ts" : "./server.js", import.meta.url),
  );

export const pullsEntry = (): string =>
  fileURLToPath(
    new URL(
      fromSource ? "../cli/pulls-worker.ts" : "./pulls.js",
      import.meta.url,
    ),
  );
