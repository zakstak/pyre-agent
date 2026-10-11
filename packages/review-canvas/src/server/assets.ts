import { Context, Data, Effect, FileSystem, Layer, Path, Schema } from "effect";

/** The browser assets of the client entry, as URLs the pages link to. */
export class Assets extends Context.Service<
  Assets,
  {
    readonly styles: ReadonlyArray<string>;
    readonly scripts: ReadonlyArray<string>;
  }
>()("review-canvas/Assets") {}

export class AssetsNotBuilt extends Data.TaggedError("AssetsNotBuilt")<{
  readonly manifest: string;
}> {
  override get message() {
    return `No usable Vite manifest at ${this.manifest}. Run pnpm build first.`;
  }
}

const entry = "src/client/main.ts";
const Manifest = Schema.fromJsonString(
  Schema.Record(
    Schema.String,
    Schema.Struct({
      file: Schema.String,
      css: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
);

/** Reads the Vite manifest in the client build directory once, at startup. */
export const layerFromBuild = (clientDir: string) =>
  Layer.effect(
    Assets,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const manifest = path.join(clientDir, ".vite", "manifest.json");
      const chunks = yield* fs.readFileString(manifest).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Manifest)),
        Effect.mapError(() => new AssetsNotBuilt({ manifest })),
      );
      const chunk = chunks[entry];
      if (chunk === undefined) return yield* new AssetsNotBuilt({ manifest });
      return {
        scripts: [`/${chunk.file}`],
        styles: (chunk.css ?? []).map((file) => `/${file}`),
      };
    }),
  );
