import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import path from "node:path";

// Pixso loads the plugin UI as a single raw HTML file inside an iframe — no
// external file loading, no CDN. `viteSingleFile` inlines JS + CSS into one
// self-contained dist/ui.html that the manifest points at.
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  root: path.resolve(__dirname, "src/ui"),
  resolve: {
    alias: { "@": path.resolve(__dirname, "src/ui") },
  },
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: false, // dist also holds main.js (compiled by tsc) — don't wipe it
    target: "es2017",
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 100000000,
    rollupOptions: {
      input: path.resolve(__dirname, "src/ui/ui.html"),
    },
  },
});
