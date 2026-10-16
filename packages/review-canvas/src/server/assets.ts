import { Context, Data, Effect, FileSystem, Layer, Path } from "effect";

/** The page shell Vite builds: its `index.html`, which links the hashed scripts and styles under /assets. */
export class Assets extends Context.Service<Assets, { readonly index: string }>()(
  "review-canvas/Assets",
) {}

export class AssetsNotBuilt extends Data.TaggedError("AssetsNotBuilt")<{
  readonly file: string;
}> {
  override get message() {
    return `No page shell at ${this.file}. Run pnpm build first.`;
  }
}

/** Reads the built page shell once, at startup. */
export const layerFromBuild = (clientDir: string) =>
  Layer.effect(
    Assets,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = path.join(clientDir, "index.html");
      const index = yield* fs
        .readFileString(file)
        .pipe(Effect.mapError(() => new AssetsNotBuilt({ file })));
      return { index };
    }),
  );
