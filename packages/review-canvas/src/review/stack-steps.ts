/**
 * The parts of a stack walkthrough both the server and the page read: a layer's steps as the agent wrote them, the
 * input whose tour they are, and the steps around a step. Browser-safe: no Node imports.
 */
import { parsePullRequest } from "../schema/forge-url.ts";
import type { ReviewInput } from "../schema/input.ts";
import type { PullRequestUrl } from "../schema/primitives.ts";
import type { StackRecord, StepKey } from "../schema/stack.ts";
import { pullRequestKey } from "../schema/target.ts";
import type { Stop } from "../schema/tour.ts";

/** A PR's short name: `#42`, or `!42` for a GitLab merge request. */
export const pullNumber = (url: PullRequestUrl): string => {
  const address = parsePullRequest(url);
  return `${address?.provider === "gitlab" ? "!" : "#"}${address?.number ?? ""}`;
};

/** The steps of one layer as the agent wrote them, with each one's index in the walkthrough. */
export const authoredSteps = (
  record: Pick<StackRecord, "walkthrough">,
  url: PullRequestUrl,
): ReadonlyArray<{ readonly stop: Stop; readonly authored: number }> =>
  record.walkthrough.steps.flatMap(({ layer, ...stop }, authored) =>
    pullRequestKey(layer) === pullRequestKey(url) ? [{ stop, authored }] : [],
  );

/** A layer's review input with the walkthrough's steps of that layer as its tour, which the server and page resolve alike. */
export const layerInput = (
  record: Pick<StackRecord, "walkthrough">,
  url: PullRequestUrl,
  input: ReviewInput,
): ReviewInput => ({
  ...input,
  stops: authoredSteps(record, url).map((item) => item.stop),
});

/** The steps before and after a step, across layer boundaries. */
export const neighbors = <S extends { readonly key: StepKey }>(
  steps: ReadonlyArray<S>,
  at: StepKey,
) => {
  const index = steps.findIndex((step) => step.key === at);
  return {
    index,
    previous: index > 0 ? steps[index - 1] : undefined,
    next: index === -1 ? undefined : steps[index + 1],
  };
};
