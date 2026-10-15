/** Hosted review URLs are data: never infer an API host from an unvalidated string. */
export type Forge = "github" | "gitlab" | "gitea";

export interface PullRequestAddress {
  readonly provider: Forge;
  readonly origin: string;
  readonly host: string;
  readonly repository: string;
  readonly number: string;
  readonly url: string;
  readonly repositoryUrl: string;
}

/** Standard GitHub/Enterprise, GitLab (including subgroups), and Gitea/Forgejo web URLs. */
export const parsePullRequest = (
  value: string,
): PullRequestAddress | undefined => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const rawPath = /^https:\/\/[^/?#@\\]+(\/.*)$/.exec(value)?.[1];
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    /[\x00-\x20\\%]/.test(value) ||
    rawPath !== url.pathname
  )
    return undefined;
  const match = /^\/(.+)\/(pull|pulls|-\/merge_requests)\/([1-9][0-9]*)$/.exec(
    url.pathname,
  );
  if (
    match?.[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined ||
    !Number.isSafeInteger(Number(match[3]))
  )
    return undefined;
  const parts = match[1].split("/");
  if (
    parts.length < 2 ||
    parts.some(
      (part) =>
        !/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === "..",
    )
  )
    return undefined;
  const provider: Forge =
    match[2] === "pull" ? "github" : match[2] === "pulls" ? "gitea" : "gitlab";
  if (provider !== "gitlab" && parts.length !== 2) return undefined;
  return {
    provider,
    origin: url.origin,
    host: url.host,
    repository: match[1],
    number: match[3],
    url: url.href,
    repositoryUrl: `${url.origin}/${match[1]}`,
  };
};

/** A provider's own comment permalink, paired with the review it belongs to. */
export const parseForgeComment = (
  value: string,
): PullRequestAddress | undefined => {
  const at = value.indexOf("#");
  if (at === -1) return undefined;
  const fragment = value.slice(at);
  const page = value.slice(0, at);
  const pull =
    parsePullRequest(page) ??
    (page.endsWith("/files") ? parsePullRequest(page.slice(0, -6)) : undefined);
  if (pull === undefined) return undefined;
  const accepted =
    pull.provider === "github"
      ? /^#(?:discussion_r|issuecomment-|pullrequestreview-)[1-9][0-9]*$/.test(
          fragment,
        ) && !page.endsWith("/files")
      : pull.provider === "gitlab"
        ? /^#note_[1-9][0-9]*$/.test(fragment) && !page.endsWith("/files")
        : /^#(?:issuecomment-|discussion_r|pullreview-)[1-9][0-9]*$/.test(
            fragment,
          );
  return accepted ? pull : undefined;
};
