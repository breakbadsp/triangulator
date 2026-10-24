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
  },
});
