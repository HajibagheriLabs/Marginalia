import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Unit tests run in Node, not jsdom: everything under test here is server-side
 * — extraction, chunking, retrieval, citation validation. Browser behaviour is
 * covered by Playwright instead.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "evals/**/*.test.ts"],
    // PDF.js is slow to initialise on first use in a cold worker.
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
