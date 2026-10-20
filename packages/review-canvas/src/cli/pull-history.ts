import { Schema } from "effect";
import type { PullRequestAddress } from "../schema/forge-url.ts";
import { CommitSha, PullRequestUrl } from "../schema/primitives.ts";
import { OpenPullRequest } from "../schema/pull-requests.ts";
import { ForgeFailed } from "./forge-api.ts";
import { addressOf, type ForgeClients } from "./hosted.ts";

const QueryPage = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      defaultBranchRef: Schema.NullOr(Schema.Struct({ name: Schema.String })),
      pullRequests: Schema.Struct({
        nodes: Schema.Array(
          Schema.Struct({
            url: PullRequestUrl,
            title: Schema.String,
            state: Schema.Literals(["OPEN", "MERGED", "CLOSED"]),
            baseRefName: Schema.String,
            headRefName: Schema.String,
            baseRefOid: CommitSha,
            headRefOid: CommitSha,
            isCrossRepository: Schema.Boolean,
            timelineItems: Schema.Struct({
              pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean }),
              nodes: Schema.Array(
                Schema.Struct({
                  previousRefName: Schema.String,
                  currentRefName: Schema.String,
                }),
              ),
            }),
          }),
        ),
      }),
    }),
  }),
});

/** GitHub retains base-change events after retargeting and deleting a stack's branches. */
export const readHistoricalPullRequests = (
  pull: PullRequestAddress,
  clients: ForgeClients,
): ReadonlyArray<OpenPullRequest> => {
  if (pull.provider !== "github")
    throw new ForgeFailed(
      "Historical stack discovery currently supports GitHub. Open PR navigation remains available for this host.",
    );
  const [owner, name] = pull.repository.split("/");
  if (owner === undefined || name === undefined)
    throw new ForgeFailed("Expected a GitHub owner and repository.");
  const query = `query($owner:String!,$name:String!,$endCursor:String){repository(owner:$owner,name:$name){defaultBranchRef{name} pullRequests(first:100,after:$endCursor,orderBy:{field:CREATED_AT,direction:DESC}){pageInfo{hasNextPage endCursor} nodes{url title state baseRefName headRefName baseRefOid headRefOid isCrossRepository timelineItems(first:100,itemTypes:[BASE_REF_CHANGED_EVENT]){pageInfo{hasNextPage} nodes{... on BaseRefChangedEvent{previousRefName currentRefName}}}}}}}`;
  const pages = Schema.decodeUnknownSync(Schema.Array(QueryPage))(
    JSON.parse(
      clients.gh([
        "api",
        "--hostname",
        pull.host,
        "graphql",
        "--paginate",
        "--slurp",
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "-f",
        `query=${query}`,
      ]),
    ),
  );
  const items = pages.flatMap((page) =>
    page.data.repository.pullRequests.nodes.map((item) => {
      const address = addressOf(item.url);
      if (
        address.host !== pull.host ||
        address.repository.toLowerCase() !== pull.repository.toLowerCase()
      )
        throw new ForgeFailed(
          "The git host returned historical PRs from another repository.",
        );
      return Schema.decodeSync(OpenPullRequest)({
        url: item.url,
        title: item.title,
        base_branch: item.baseRefName,
        head_branch: item.headRefName,
        same_repository: !item.isCrossRepository,
        history: {
          state: item.state,
          base_sha: item.baseRefOid,
          head_sha: item.headRefOid,
          default_branch: page.data.repository.defaultBranchRef?.name ?? "",
          base_branches: [
            ...new Set([
              item.baseRefName,
              ...item.timelineItems.nodes
                .toReversed()
                .map((event) => event.previousRefName),
            ]),
          ],
          timeline_complete: !item.timelineItems.pageInfo.hasNextPage,
        },
      });
    }),
  );
  if (items.length > 2000)
    throw new ForgeFailed(
      "Historical discovery exceeds 2000 PRs; no complete stack history is available for this repository.",
    );
  return items;
};
