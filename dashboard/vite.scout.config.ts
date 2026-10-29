// Bundles tri-scout into one file, build/tri-scout.mjs, with its
// dependencies inside, so the collector host needs only Node.
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    ssr: "src/scout/main.ts",
    target: "node24",
    outDir: "../build",
    emptyOutDir: false,
    copyPublicDir: false,
    rollupOptions: { output: { entryFileNames: "tri-scout.mjs" } },
  },
  ssr: { noExternal: true },
});
