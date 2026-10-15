/**
 * What a build was made from, as one hash, so a command knows whether the build in dist is the build of the sources
 * beside it: the package's manifest and lockfile, every source the bundles are made from, the page's entry and the
 * build configs, and the shared style the page imports. Tests are not inputs. File times are not consulted: a copy of
 * the package that kept old times, or one that touched every file, still gets the right answer.
 *
 * It runs as a command with only Node's own modules, so it works before the dependencies are installed:
 *
 *   node src/cli/stamp.ts --check   exits 0 when dist carries this hash, 1 when it does not
 *   node src/cli/stamp.ts --write   writes the hash into dist/build.json, after a build
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL("../../", import.meta.url));

/** The build's inputs, relative to the package root: single files, then every file under these folders. */
const FILES = ["package.json", "pnpm-lock.yaml", "tsconfig.json", "index.html", "vite.config.ts", "vite.node.config.ts"];
const FOLDERS = ["src", "../../skills/internal-visual-style/assets"];

const isInput = (path: string): boolean => !/\.test\.tsx?$/.test(path);

/** Every file under a folder, deepest last within each folder, in name order, so the hash does not depend on the disk. */
const walk = (dir: string): ReadonlyArray<string> =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : entry.isFile() ? [join(dir, entry.name)] : []))
    : [];

/** The hash of the inputs' paths and contents. */
export const inputsHash = (root = here): string => {
  const hash = createHash("sha256");
  const files = [...FILES.map((file) => join(root, file)).filter(existsSync), ...FOLDERS.flatMap((folder) => walk(join(root, folder)))];
  for (const file of files.filter(isInput)) {
    hash.update(relative(root, file).split(sep).join("/"));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
};

export const stampPath = (root = here): string => join(root, "dist/build.json");

/** The hash the build in dist records, or none when there is no build or no stamp. */
export const readStamp = (root = here): string | undefined => {
  try {
    const stamp: unknown = JSON.parse(readFileSync(stampPath(root), "utf8"));
    return typeof stamp === "object" && stamp !== null && "inputs" in stamp && typeof stamp.inputs === "string" ? stamp.inputs : undefined;
  } catch {
    return undefined;
  }
};

/** Records the inputs' hash beside the build, once the build has finished. */
export const writeStamp = (root = here): void => {
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(stampPath(root), `${JSON.stringify({ inputs: inputsHash(root), built_at: new Date().toISOString() }, null, 2)}\n`);
};

/** Whether the build in dist was made from the sources beside it. */
export const fresh = (root = here): boolean => readStamp(root) === inputsHash(root);

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const mode = process.argv[2];
  if (mode === "--write") writeStamp();
  else if (mode === "--check") process.exitCode = fresh() ? 0 : 1;
  else {
    process.stderr.write("usage: node stamp.ts --check | --write\n");
    process.exitCode = 2;
  }
}
