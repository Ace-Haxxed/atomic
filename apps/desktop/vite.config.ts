import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const here = (relative: string) =>
  fileURLToPath(new URL(relative, import.meta.url));

/**
 * Tauri serves the dev server on a fixed port and points the webview at it, so
 * the port must be stable and HMR must not fall back to a random one.
 */
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Order matters: Vite matches aliases by prefix, so the stylesheet has to be
    // registered before the bare package name or `@atomic/ui/styles.css` would
    // resolve to `index.ts/styles.css`.
    alias: {
      "@atomic/ui/styles.css": here("../../packages/ui/src/styles.css"),
      "@atomic/ui": here("../../packages/ui/src/index.ts"),
      "@": here("./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      // The Rust side has its own watcher; watching it here only burns cycles.
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    // Tauri 2 ships a modern webview on every platform we target.
    target: "es2022",
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    outDir: "dist",
    emptyOutDir: true,
  },
});
