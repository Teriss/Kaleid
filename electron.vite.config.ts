// @ts-expect-error Pinned upstream build plugin is JavaScript.
import { traditionalLocalePlugin } from "./vendor/folia/dev/i18n/traditionalLocalePlugin.mjs";
// @ts-expect-error Pinned upstream build plugin is JavaScript.
import { icuFoliaDataPlugin } from "./vendor/folia/dev/icuFolia/icuFoliaDataPlugin.mjs";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          worker: resolve("src/main/worker.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve("src/preload/index.ts"),
        output: { format: "cjs", entryFileNames: "index.cjs" },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    plugins: [
      traditionalLocalePlugin(),
      icuFoliaDataPlugin(),
      tailwindcss(),
      react(),
      {
        name: "development-csp",
        apply: "serve",
        transformIndexHtml(html) {
          return html
            .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
            .replace("connect-src 'self'", "connect-src 'self' ws:");
        },
      },
    ],
    build: { rollupOptions: { input: resolve("src/renderer/index.html") } },
  },
});
