import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig(() => ({
  plugins: [react()],
  base: process.env.TAURI_DEBUG ? "/" : "./",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: process.env.TAURI_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: process.env.TAURI_DEBUG ? false : "esbuild",
    sourcemap: !!process.env.TAURI_DEBUG,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        about: resolve(__dirname, "about.html"),
        settings: resolve(__dirname, "settings.html"),
        clone: resolve(__dirname, "clone.html"),
        resultLog: resolve(__dirname, "result-log.html")
      }
    }
  }
}));
