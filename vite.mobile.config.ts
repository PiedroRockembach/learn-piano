import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// The Android app's web layer: same modules as the desktop renderer, mobile interface in src/mobile.
export default defineConfig({
  root: here("./src/mobile"),
  base: "./",
  build: { outDir: here("./dist/mobile"), emptyOutDir: true, chunkSizeWarningLimit: 4000 },
  server: { port: 5174, host: true },
});
