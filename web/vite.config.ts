import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  // Relative base so the built site works from any static path.
  base: "./",
  // OFFLINE gates the double-click file:// path; the served build is online,
  // so the offline branches (file picker, inlined-Blob worker) dead-code out.
  define: {
    OFFLINE: "false",
  },
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        storage: resolve(__dirname, "storage.html"),
      },
    },
  },
  worker: {
    format: "es",
  },
});
