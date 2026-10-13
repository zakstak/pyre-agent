/** A repository's identity is separate from the directories that contain its copies. */
import * as Schema from "effect/Schema";
import { nonEmptyText, WorktreeRoot } from "./primitives.ts";

export const RepositoryIdentity = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("remote"), address: nonEmptyText(8192) }),
  Schema.Struct({ kind: Schema.Literal("local"), git_dir: WorktreeRoot }),
  /** An accepted path from an older database that cannot yet be identified. */
  Schema.Struct({ kind: Schema.Literal("unresolved"), root: WorktreeRoot }),
]);
export type RepositoryIdentity = typeof RepositoryIdentity.Type;

export const MAX_REPOSITORY_ID_UNITS = 16384;
export const RepositoryId = nonEmptyText(MAX_REPOSITORY_ID_UNITS).pipe(Schema.brand("RepositoryId"));
export type RepositoryId = typeof RepositoryId.Type;

export const Repository = Schema.Struct({
  identity: RepositoryIdentity,
  checkouts: Schema.NonEmptyArray(WorktreeRoot),
});
export type Repository = typeof Repository.Type;

export const repositoryId = (identity: RepositoryIdentity): RepositoryId => {
  switch (identity.kind) {
    case "remote": return Schema.decodeSync(RepositoryId)(`remote:${identity.address}`);
    case "local": return Schema.decodeSync(RepositoryId)(`local:${identity.git_dir}`);
    case "unresolved": return Schema.decodeSync(RepositoryId)(`unresolved:${identity.root}`);
  }
};
