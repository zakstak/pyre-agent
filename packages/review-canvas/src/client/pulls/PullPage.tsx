import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Effect, Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo, useState } from "react";
import { parseRows } from "../../review/patch.ts";
import type { ReviewFile, ReviewInput } from "../../schema/input.ts";
import type { PullRequestUrl } from "../../schema/primitives.ts";
import type { RepositoryId } from "../../schema/repositories.ts";
import { pullRequestKey } from "../../schema/target.ts";
import { homeAtom } from "../home/data.ts";
import { ReviewStack } from "../home/PullRequests.tsx";
import { epochAtom, PageClient } from "../rpc.ts";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { FIELD } from "../ui/field.ts";
import { frame, SkipLink, TopBar } from "../ui/page.tsx";
import { Time } from "../ui/text.tsx";

const snapshotAtom = Atom.family(
  (request: { readonly id: RepositoryId; readonly url: PullRequestUrl }) =>
    PageClient.runtime.atom((get) => {
      if (get(epochAtom) === 0) return Effect.never;
      return Effect.flatMap(PageClient, (client) =>
        client("pulls.read", request),
      );
    }),
);

/** Shares the review parser and semantic diff colors without registering a synthetic agent. */
export const ReadOnlyDiff = ({ file }: { readonly file: ReviewFile }) => (
  <div className="overflow-hidden rounded-panel border border-separator">
    <div className="border-b border-separator bg-surface p-4">
      <h3 className="wrap-anywhere font-mono text-technical">{file.path}</h3>
      <p className="text-small text-muted">
        {file.status} · +{file.additions} / −{file.deletions}
      </p>
      {file.patch_complete === false ? (
        <p className="text-small text-warning">This patch is incomplete.</p>
      ) : null}
    </div>
    {file.patch === undefined ? (
      <p className="p-4">
        Patch unavailable
        {file.patch_note === undefined ? "." : `: ${file.patch_note}.`}
      </p>
    ) : (
      <div
        role="region"
        aria-label={`Diff for ${file.path}`}
        tabIndex={0}
        className="max-h-[44rem] overflow-auto bg-code py-4"
      >
        <table className="w-full border-collapse font-mono text-technical leading-normal">
          <tbody>
            {parseRows(file.patch).map((row) => (
              <tr
                key={row.index}
                className={cn(
                  row.kind === "add" && "bg-diff-addition",
                  row.kind === "del" && "bg-diff-deletion",
                  row.kind === "hunk" && "bg-subtle",
                )}
              >
                <td className="select-none px-2 text-right text-muted">
                  {row.old}
                </td>
                <td className="select-none px-2 text-right text-muted">
                  {row.new}
                </td>
                <td className="w-full whitespace-pre px-4">{row.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </div>
);

const Files = ({ input }: { readonly input: ReviewInput }) => {
  const [path, setPath] = useState("");
  const file = input.files.find((item) => item.path === path) ?? input.files[0];
  return (
    <>
      <label className="mb-4 block">
        Changed file
        <select
          className={cn(FIELD, "ml-2 max-w-full font-mono text-technical")}
          value={file?.path ?? ""}
          onChange={(event) => setPath(event.currentTarget.value)}
        >
          {input.files.map((item) => (
            <option key={item.path} value={item.path}>
              {item.path} (+{item.additions} / −{item.deletions})
            </option>
          ))}
        </select>
      </label>
      {file === undefined ? (
        <p>No changed files in this comparison.</p>
      ) : (
        <ReadOnlyDiff file={file} />
      )}
    </>
  );
};

export const PullPage = ({
  id,
  url,
}: {
  readonly id: RepositoryId;
  readonly url: PullRequestUrl;
}) => {
  const request = useMemo(() => ({ id, url }), [id, url]);
  const atom = snapshotAtom(request);
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const snapshot = Option.getOrUndefined(AsyncResult.value(result));
  const home = Option.getOrUndefined(AsyncResult.value(useAtomValue(homeAtom)));
  const review = home?.reviews.find(
    (item) =>
      item.closed_at === undefined &&
      item.target.kind !== "worktree" &&
      pullRequestKey(item.target.url) === pullRequestKey(url),
  );
  return (
    <>
      <SkipLink />
      <TopBar width="review" place="Pull request">
        <a href={url} className="underline">
          Open on host
        </a>
      </TopBar>
      <main
        id="main"
        tabIndex={-1}
        className={cn(frame({ width: "review" }), "min-w-0 pt-8 pb-16")}
      >
        <div className="mb-4 flex flex-wrap items-center gap-4">
          <h1 className="text-heading font-semibold">Pull request diff</h1>
          <Button disabled={result.waiting} onClick={refresh}>
            Refresh diff
          </Button>
        </div>
        {result.waiting ? (
          <p role="status">Collecting the PR snapshot…</p>
        ) : null}
        {AsyncResult.isFailure(result) ? (
          <p role="alert">Could not load the PR. Retry with Refresh diff.</p>
        ) : null}
        {snapshot?.kind === "unavailable" ? (
          <p role="alert">{snapshot.message}</p>
        ) : null}
        {snapshot?.kind === "ready" ? (
          <>
            <h2 className="text-heading font-semibold">
              {snapshot.input.target.title}
            </h2>
            <p className="my-2 text-small text-muted">
              {snapshot.input.files.length} files · collected{" "}
              <Time at={snapshot.collected_at} />
            </p>
            <p className="mb-4 wrap-anywhere font-mono text-technical">
              Head {snapshot.input.target.head_sha}
            </p>
            {snapshot.warnings.map((warning) => (
              <p key={warning} role="alert" className="mb-2 text-warning">
                {warning}
              </p>
            ))}
            {review === undefined ? (
              <p className="mb-4 text-small text-muted">
                Read the diff now. Ask an agent to review this PR when you want
                a guided tour and a feedback conversation.
              </p>
            ) : (
              <p className="mb-4">
                <a href={`/reviews/${review.id}`} className="underline">
                  Continue guided review
                </a>
              </p>
            )}
            <ReviewStack target={snapshot.input.target} />
            <Files input={snapshot.input} />
          </>
        ) : null}
      </main>
    </>
  );
};
