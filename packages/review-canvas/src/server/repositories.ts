/** Local discovery proposes working trees. Reading a proposal never enrolls it. */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { Schema } from "effect";
import {
  GIT_CONFIG,
  gitEnvironment,
  repositoryTop,
  trustedGit,
} from "../collector/git.ts";
import { WorktreeRoot } from "../schema/primitives.ts";
import {
  Repository,
  type RepositoryIdentity,
  repositoryId,
} from "../schema/repositories.ts";

const parseRoot = Schema.decodeSync(WorktreeRoot);
const skipped = new Set(["node_modules", "vendor", "dist", "build", "target"]);
const MAX_DIRECTORIES = 4_000;
const MAX_CHECKOUTS = 250;
const MAX_DEPTH = 4;

export interface Discovery {
  readonly roots: ReadonlyArray<string>;
  readonly repositories: ReadonlyArray<Repository>;
  readonly warnings: ReadonlyArray<string>;
}

export type RepositoryStatus =
  | {
      readonly kind: "ready";
      readonly branch: string | null;
      readonly changed: number;
    }
  | { readonly kind: "unavailable"; readonly message: string };

/** Common project folders plus the launch directory, without walking the whole home or filesystem. */
export const repositoryRoots = (): ReadonlyArray<string> => {
  const configured = process.env.REVIEW_CANVAS_REPO_ROOTS;
  if (configured !== undefined && configured !== "")
    return [
      ...new Set(
        configured.split(delimiter).map((root) => {
          if (!isAbsolute(root))
            throw new Error(
              "REVIEW_CANVAS_REPO_ROOTS must contain absolute directories.",
            );
          return root;
        }),
      ),
    ];
  return [
    ...new Set([
      repositoryTop(process.cwd()) ?? process.cwd(),
      join(homedir(), "git"),
      join(homedir(), "dev"),
    ]),
  ].filter((root) => root !== "/" && existsSync(root));
};

/** One scan budget covers traversal, root validation, and identity reads. Only real working trees prune the walk. */
export const discoverRepositories = async (
  roots: ReadonlyArray<string>,
): Promise<Discovery> => {
  const candidates = new Set<WorktreeRoot>();
  const visited = new Set<string>();
  const warnings: Array<string> = [];
  const deadline = Date.now() + 2_000;
  const signal = AbortSignal.timeout(2_000);
  const expired = () => signal.aborted || Date.now() >= deadline;
  let entries = 0;
  let limited = false;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (visited.has(directory)) return;
    if (
      visited.size >= MAX_DIRECTORIES ||
      candidates.size >= MAX_CHECKOUTS ||
      entries >= 20_000 ||
      expired()
    ) {
      limited = true;
      return;
    }
    visited.add(directory);
    try {
      const marker = await lstat(join(directory, ".git")).catch(
        () => undefined,
      );
      if (marker?.isDirectory() || marker?.isFile()) {
        try {
          candidates.add(await workingTreeRoot(parseRoot(directory), signal));
          return;
        } catch {
          if (expired()) {
            limited = true;
            return;
          }
          warnings.push(`Could not identify the checkout at ${directory}.`);
          // A stale or forged marker must not hide valid repositories beneath it.
        }
      }
      if (depth === MAX_DEPTH) {
        warnings.push(
          `Depth limit reached at ${directory}. Scan a narrower directory to find deeper repositories.`,
        );
        return;
      }
      const dir = await opendir(directory);
      for await (const entry of dir) {
        entries++;
        if (entries >= 20_000 || expired() || limited) {
          limited = true;
          break;
        }
        if (
          entry.isDirectory() &&
          !entry.name.startsWith(".") &&
          !skipped.has(entry.name)
        )
          await walk(join(directory, entry.name), depth + 1);
      }
    } catch {
      warnings.push(`Could not scan ${directory}.`);
    }
  };
  for (const root of roots) {
    try {
      if (!isAbsolute(root)) throw new Error("Use an absolute directory.");
      await walk(await realpath(root), 0);
    } catch {
      warnings.push(
        `Could not scan ${root}. Use an existing absolute directory.`,
      );
    }
  }
  const identified = await mapCheckouts(
    [...candidates].sort(),
    async (root) => {
      if (expired()) {
        limited = true;
        return undefined;
      }
      try {
        return await identifyRepository(root, signal);
      } catch {
        if (expired()) limited = true;
        else warnings.push(`Could not identify the checkout at ${root}.`);
        return undefined;
      }
    },
  );
  if (limited)
    warnings.push(
      "The scan reached its size or time limit. Scan a narrower directory to find more repositories.",
    );
  return {
    roots,
    repositories: groupRepositories(
      identified.filter((item) => item !== undefined),
    ),
    warnings,
  };
};

/** Uses the collector's trusted executable and environment, with bounded asynchronous reads. */
const git = (
  root: string,
  args: ReadonlyArray<string>,
  options: {
    readonly ok?: ReadonlyArray<number>;
    readonly signal?: AbortSignal | undefined;
  } = {},
): Promise<string> => {
  options.signal?.throwIfAborted();
  const executable = trustedGit({ repo: root }).executable;
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...GIT_CONFIG, ...args],
      {
        cwd: root,
        env: gitEnvironment({}),
        timeout: 3_000,
        killSignal: "SIGKILL",
        maxBuffer: 2 * 1024 * 1024,
        signal: options.signal,
      },
      (error, stdout) => {
        if (
          error !== null &&
          !(
            typeof error.code === "number" &&
            (options.ok ?? [0]).includes(error.code)
          )
        )
          reject(
            new Error(
              "Repository metadata could not be read within the time and output limits.",
            ),
          );
        else resolve(stdout);
      },
    );
  });
};

/** Acceptance verifies a real working tree root, so subdirectories and forged markers cannot be enrolled. */
const workingTreeRoot = async (
  root: WorktreeRoot,
  signal?: AbortSignal,
): Promise<WorktreeRoot> => {
  const canonical = parseRoot(await realpath(root));
  const top = await git(canonical, ["rev-parse", "--show-toplevel"], {
    signal,
  });
  if ((await realpath(top.replace(/\n$/, ""))) !== canonical)
    throw new Error("Choose the repository root, not a subdirectory.");
  return canonical;
};

/** Strip credentials and normalize the common HTTPS, SSH, and scp spellings of a Git remote. */
export const remoteAddress = (remote: string): string | null => {
  if (!remote.includes("://") && remote.includes("::")) return null;
  let parsed: URL;
  try {
    const scp = /^(?:[^@/:]+@)?(\[[^\]]+\]|[^/:]+):(.+)$/.exec(remote);
    parsed = new URL(
      remote.includes("://")
        ? remote
        : scp?.[1] !== undefined && scp[2] !== undefined
          ? `ssh://${scp[1]}/${scp[2]}`
          : "",
    );
  } catch {
    return null;
  }
  if (
    !["https:", "http:", "ssh:", "git:"].includes(parsed.protocol) ||
    parsed.search !== "" ||
    parsed.hash !== ""
  )
    return null;
  const port =
    (parsed.port === "22" && parsed.protocol === "ssh:") ||
    (parsed.port === "9418" && parsed.protocol === "git:")
      ? ""
      : parsed.port;
  let path = parsed.pathname.replace(/^\/+|\/+$/g, "");
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "github.com") path = path.toLowerCase();
  path = path.replace(/\.git$/, "");
  if (path === "" || path.startsWith("~")) return null;
  return `${hostname}${port === "" ? "" : `:${port}`}/${path}`;
};

export const identifyRepository = async (
  root: WorktreeRoot,
  signal?: AbortSignal,
): Promise<Repository> => {
  const canonical = await workingTreeRoot(root, signal);
  return Schema.decodeSync(Repository)({
    identity: await identityOf(canonical, new Set(), signal),
    checkouts: [canonical],
  });
};

const identityOf = async (
  root: WorktreeRoot,
  visited: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<RepositoryIdentity> => {
  const common = parseRoot(
    await realpath(
      (
        await git(
          root,
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          { signal },
        )
      ).replace(/\n$/, ""),
    ),
  );
  const local = { kind: "local" as const, git_dir: common };
  if (visited.has(common) || visited.size >= 4) return local;
  const remotes = (await git(root, ["remote"], { signal }))
    .trim()
    .split("\n")
    .filter(Boolean);
  const primary = remotes.includes("origin")
    ? "origin"
    : remotes.length === 1
      ? remotes[0]
      : undefined;
  const remote =
    primary === undefined
      ? ""
      : (
          await git(root, ["remote", "get-url", "--", primary], { signal })
        ).replace(/\n$/, "");
  const address = remoteAddress(remote);
  if (address !== null) return { kind: "remote", address };
  // Follow local clone sources without expanding the scan to include their directories.
  if (
    remote !== "" &&
    (isAbsolute(remote) ||
      remote.startsWith("./") ||
      remote.startsWith("../") ||
      !remote.includes(":") ||
      remote.startsWith("file://"))
  ) {
    try {
      const path = remote.startsWith("file://")
        ? new URL(remote)
        : resolve(root, remote);
      const source = parseRoot(await realpath(path));
      try {
        await workingTreeRoot(source, signal);
      } catch {
        signal?.throwIfAborted();
        if (
          (
            await git(source, ["rev-parse", "--is-bare-repository"], { signal })
          ).trim() !== "true"
        )
          return local;
      }
      return await identityOf(source, new Set([...visited, common]), signal);
    } catch {
      signal?.throwIfAborted();
      // A missing or unsupported clone source falls back to the common Git directory.
    }
  }
  return local;
};

/** Clones share a remote identity; worktrees without remotes share their common Git directory. */
export const groupRepositories = (
  repositories: ReadonlyArray<Repository>,
): ReadonlyArray<Repository> => {
  const groups = new Map<ReturnType<typeof repositoryId>, Repository>();
  for (const repository of repositories) {
    const id = repositoryId(repository.identity);
    const existing = groups.get(id);
    const head = repository.checkouts[0];
    const rest = [
      ...new Set([...(existing?.checkouts ?? []), ...repository.checkouts]),
    ].filter((root) => root !== head);
    const checkouts: [WorktreeRoot, ...Array<WorktreeRoot>] = [head, ...rest];
    groups.set(id, {
      identity: repository.identity,
      checkouts: checkouts.sort(),
    });
  }
  return [...groups.values()].sort((a, b) =>
    repositoryName(a).localeCompare(repositoryName(b)),
  );
};

/** A small worker pool bounds Git processes independently of the number of discovered copies. */
export const mapCheckouts = async <A, B>(
  items: ReadonlyArray<A>,
  read: (item: A) => Promise<B>,
): Promise<Array<B>> => {
  const results = new Map<number, B>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      for (;;) {
        const index = next++;
        const item = items[index];
        if (item === undefined) return;
        results.set(index, await read(item));
      }
    }),
  );
  return [...results.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, result]) => result);
};

/** A checkout's branch and changed items. An aborted read stops its Git processes and reads as unavailable. */
export const checkoutStatus = async (
  root: WorktreeRoot,
  identity?: Repository["identity"],
  signal?: AbortSignal,
): Promise<RepositoryStatus> => {
  try {
    const current = await identifyRepository(root, signal);
    if (
      identity !== undefined &&
      repositoryId(identity) !== repositoryId(current.identity)
    )
      return {
        kind: "unavailable",
        message: "This checkout now belongs to a different repository.",
      };
    const output = await git(
      root,
      [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=normal",
        "--ignore-submodules=all",
      ],
      { signal },
    );
    let changed = 0;
    const records = output.split("\0");
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (record === undefined || record === "") continue;
      changed++;
      if (record.slice(0, 2).includes("R") || record.slice(0, 2).includes("C"))
        i++;
    }
    const branch = (
      await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
        ok: [0, 1],
        signal,
      })
    ).replace(/\n$/, "");
    return { kind: "ready", branch: branch === "" ? null : branch, changed };
  } catch {
    return {
      kind: "unavailable",
      message: "Repository unavailable or Git status could not be read.",
    };
  }
};

export const repositoryName = (repository: Repository): string => {
  switch (repository.identity.kind) {
    case "remote":
      return repository.identity.address;
    case "local":
      return basename(repository.identity.git_dir) === ".git"
        ? basename(dirname(repository.identity.git_dir))
        : basename(repository.identity.git_dir);
    case "unresolved":
      return basename(repository.identity.root);
  }
};
