/** Targets as both pages name them. */
import type { Target } from "../../schema/target.ts";
import { targetName } from "../names.ts";

/** A target in one line of mono text: `acme/ledger #412`, or `ledger-webhooks · feat/x`. */
export const TargetText = ({ target }: { readonly target: Target }) => {
  const name = targetName(target);
  if (name.kind === "pr")
    return (
      <code className="wrap-anywhere">
        {name.repository} <span className="text-muted">{name.number}</span>
      </code>
    );
  return (
    <code className="wrap-anywhere" title={name.root}>
      {name.checkout}{" "}
      {name.branch === undefined ? (
        <span className="text-muted">· detached</span>
      ) : (
        <>
          <span className="text-muted">·</span> {name.branch}
        </>
      )}
    </code>
  );
};
