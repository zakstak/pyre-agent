import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Vite builds only the browser assets. The Effect server renders every page and serves this output.
export default defineConfig({
  plugins: [tailwindcss()],
  publicDir: false,
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    manifest: true,
    rolldownOptions: { input: "src/client/main.ts" },
  },
});
