import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Vite builds the page: index.html, which the server sends for every page path, and the React app under /assets.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  publicDir: false,
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    // The server's identity hashes the manifest, so a daemon serving other assets is never reused.
    manifest: true,
    // One chunk of React and Effect, served from loopback: splitting it would buy nothing.
    chunkSizeWarningLimit: 800,
    rolldownOptions: { input: "index.html" },
  },
});
