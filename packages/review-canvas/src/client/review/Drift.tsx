/**
 * What changed since the round the page shows, until the next round replaces it: an agent's check of a working tree,
 * or commits pushed to a pull request, which the server notices in the head its host shows, read while the page shows
 * the review or in the repository's list of open pull requests, and has the host compare with the round's head. A line under the title says it; each stop whose files changed names them, as a
 * stop a new round changed does.
 */
import { TriangleAlert } from "lucide-react";
import type { RepoPath } from "../../schema/primitives.ts";
import { fileElementId } from "../../review/next.ts";
import { count, splitPath } from "../names.ts";
import { cn } from "../ui/cn.ts";
import { Joined, Time } from "../ui/text.tsx";
import { usePage } from "./act.ts";
import { hashOf } from "./places.ts";
import type { PageModel } from "./view.ts";

/** How many changed files the line under the title names before "and N more". */
const SHOWN_PATHS = 4;

/** A changed file: a link to its block when the round has it, by its whole path or by its name. */
const FileLink = ({
  page,
  path,
  name,
}: {
  readonly page: PageModel;
  readonly path: RepoPath;
  readonly name: "path" | "base";
}) => {
  const text = name === "path" ? path : splitPath(path).base;
  return page.files.has(path) ? (
    <a
      href={hashOf(fileElementId(path))}
      data-drift-file={path}
      title={path}
      className="text-link underline underline-offset-3"
    >
      <code>{text}</code>
    </a>
  ) : (
    <code title={path}>{text}</code>
  );
};

/** The changed files the line names, the first few and how many more. */
const Paths = ({
  page,
  paths,
}: {
  readonly page: PageModel;
  readonly paths: ReadonlyArray<RepoPath>;
}) => (
  <>
    <Joined
      items={paths.slice(0, SHOWN_PATHS).map((path) => (
        <FileLink page={page} path={path} name="path" />
      ))}
    />
    {paths.length > SHOWN_PATHS
      ? ` and ${paths.length - SHOWN_PATHS} more`
      : ""}
  </>
);

/**
 * The line under the title. For a pull request whose head moved: that commits were pushed, how many the host counts,
 * the new head, and the files that changed, or why the host could not list them. Otherwise the files an agent found
 * changed.
 */
export const DriftLine = () => {
  const { page } = usePage();
  if (page.drift === undefined) return null;
  const { found } = page.drift;
  const checked = (
    <span className="text-muted">
      · checked <Time at={found.checked_at} /> · the agents publish a new round
      with {found.head_sha === undefined ? "the change" : "them"}.
    </span>
  );
  if (found.head_sha === undefined)
    return (
      <p id="drift" className="mt-2 text-small">
        <strong className="text-warning">Changed since this round:</strong>{" "}
        {found.paths.length === 0 ? (
          <span className="text-muted">the code</span>
        ) : (
          <Paths page={page} paths={found.paths} />
        )}{" "}
        {checked}
      </p>
    );
  const { compared } = found;
  const commits =
    compared === undefined || compared.kind === "failed"
      ? undefined
      : compared.commits;
  const reason =
    compared === undefined
      ? "the files that changed are not known"
      : compared.kind === "listed"
        ? undefined
        : compared.reason;
  return (
    <p id="drift" data-pushed={found.head_sha} className="mt-2 text-small">
      <strong className="text-warning">
        New commits pushed since round {page.round.round}:
      </strong>{" "}
      {commits === undefined ? null : (
        <>
          {count(commits, "commit")} <span className="text-muted">·</span>{" "}
        </>
      )}
      <span className="text-muted">head</span>{" "}
      <code title={found.head_sha}>{found.head_sha.slice(0, 7)}</code>
      {found.paths.length === 0 ? null : (
        <>
          {" "}
          <span className="text-muted">· changed</span>{" "}
          <Paths page={page} paths={found.paths} />
        </>
      )}
      {reason === undefined ? null : (
        <span className="text-muted"> · {reason}</span>
      )}{" "}
      {checked}
    </p>
  );
};

/** In a stop's row of the contents: the files it owns or excerpts that changed since this round, by their names. */
export const DriftFiles = ({ stop }: { readonly stop: number }) => {
  const { page } = usePage();
  const files = page.drift?.stops.get(stop);
  if (files === undefined) return null;
  return (
    <span
      data-drift-files={stop}
      className="block truncate font-mono text-technical font-normal text-warning"
    >
      since round {page.round.round}:{" "}
      {files.map((path) => splitPath(path).base).join(", ")}
    </span>
  );
};

/** For a stop whose files changed since this round: which, as links to them. */
export const StopDrift = ({
  stop,
  className,
}: {
  readonly stop: number;
  readonly className?: string;
}) => {
  const { page } = usePage();
  const files = page.drift?.stops.get(stop);
  if (files === undefined) return null;
  return (
    <p data-stop-drift={stop} className={cn("min-w-0 text-small", className)}>
      <TriangleAlert
        aria-hidden="true"
        className="mr-1.5 inline size-3.5 align-[-0.125em] text-warning"
      />
      <strong className="font-semibold text-warning">
        Changed since round {page.round.round}:
      </strong>{" "}
      <Joined
        items={files.map((path) => (
          <FileLink page={page} path={path} name="base" />
        ))}
      />
    </p>
  );
};
