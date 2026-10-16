/** A daemon captures the installed code and asset identity before it starts listening. */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { clientDir, codeDir, dependencyFile } from "./install.ts";

export const ServerIdentity = Schema.Struct({
  ok: Schema.Literal(true),
  revision: Schema.String,
  instance: Schema.String,
});

export const installedRevision = (): string => {
  const code = codeDir();
  const hash = createHash("sha256").update(realpathSync(code));
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (
        /\.(ts|js)$/.test(entry.name) &&
        !entry.name.endsWith(".test.ts")
      ) {
        hash
          .update(path.slice(code.length))
          .update("\0")
          .update(readFileSync(path))
          .update("\0");
      }
    }
  };
  visit(code);
  hash.update(readFileSync(join(clientDir(), ".vite/manifest.json")));
  // In a checkout the lockfile identifies dependencies; in a tarball package.json does.
  const root = join(clientDir(), "..", "..");
  hash.update(readFileSync(join(root, "package.json")));
  hash.update(readFileSync(dependencyFile()));
  return hash.digest("hex");
};
