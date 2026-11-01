import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    // The theme test reads the shipped stylesheet as text.
    css: { include: [/src\/style\.css/] },
    // Full-App tests use fake timers, so this limit measures CPU work only.
    // They take up to 3.3 s on a normal CI runner and over 5 s, the vitest
    // default, when the shared runner is about two times slower. A hang
    // still fails at this limit.
    testTimeout: 20_000,
  },
});
