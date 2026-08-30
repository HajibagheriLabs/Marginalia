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
    // Populates process.env from .env.local so modules that read src/lib/env.ts
    // at import time are importable. Integration tests skip themselves when the
    // credentials they need are absent.
    setupFiles: ["./vitest.setup.ts"],
    // PDF.js is slow to initialise on first use in a cold worker, and the
    // embedding tests download ~34 MB of model weights on a cold cache.
    testTimeout: 20_000,
    hookTimeout: 120_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
