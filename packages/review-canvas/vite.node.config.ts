import { defineConfig } from "vite";

/**
 * The server and the command as JavaScript for an installed package: Node refuses to strip types from files under
 * node_modules. Dependencies and Node's modules stay imports; everything of this package is bundled into dist/node.
 */
export default defineConfig({
  publicDir: false,
  build: {
    ssr: true,
    outDir: "dist/node",
    emptyOutDir: true,
    target: "node26",
    minify: false,
    sourcemap: true,
    rolldownOptions: {
      input: {
        server: "src/server/main.ts",
        cli: "src/cli/main.ts",
        pulls: "src/cli/pulls-worker.ts",
      },
      output: {
        format: "esm",
        entryFileNames: "[name].js",
        chunkFileNames: "[name]-[hash].js",
      },
    },
  },
});
