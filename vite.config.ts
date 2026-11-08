import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig(() => ({
  plugins: [react()],
  base: process.env.TAURI_DEBUG ? "/" : "./",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/.flatpak-*/**", "**/packaging/flatpak/**"]
    }
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: process.env.TAURI_PLATFORM === "windows" ? "chrome105" : "es2020",
    minify: process.env.TAURI_DEBUG ? false : "esbuild",
    sourcemap: !!process.env.TAURI_DEBUG,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        about: resolve(import.meta.dirname, "about.html"),
        settings: resolve(import.meta.dirname, "settings.html"),
        clone: resolve(import.meta.dirname, "clone.html"),
        resultLog: resolve(import.meta.dirname, "result-log.html")
      }
    }
  }
}));
