import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

import { loadEnvFile } from "./src/lib/env.file";
import { modelStubUrl } from "./e2e/support/model-stub";

/**
 * THE BROWSER SUITE.
 *
 * One happy path, end to end, against a real build: sign in, watch a document
 * that has been through the real ingestion pipeline, ask a question, see the
 * answer stream in with a citation, click the citation, and watch the viewer
 * scroll and ink the passage.
 *
 * It is one path on purpose. Everything that can be asserted more precisely
 * lower down already is — isolation, citation validation, idempotency and
 * ranking all have integration suites against real Postgres and Qdrant. What
 * only a browser can tell you is whether the pieces are WIRED: whether the
 * stream reaches the pane, whether a chip is clickable, whether clicking it
 * moves the document. A second browser test asserting a business rule would be
 * a slow way to re-test something a fast test already covers.
 */

loadEnvFile(path.join(process.cwd(), ".env.local"));

const PORT = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // `.context.json` and the support modules are not specs.
  testMatch: /.*\.spec\.ts/,

  globalSetup: "./e2e/global-setup.ts",

  /*
   * Ingestion runs a local embedding model, and a cold cache downloads ~34 MB
   * before the first vector exists. The generous timeout is for that, not for
   * the browser: the assertions themselves are fast.
   */
  timeout: 120_000,
  expect: { timeout: 15_000 },

  // SERIAL, DELIBERATELY. The suite shares one user, one document and one
  // conversation; running specs in parallel against them would make the
  // ordering of citation state a race rather than a fact.
  workers: 1,
  fullyParallel: false,

  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],

  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],

  webServer: {
    /*
     * A PRODUCTION BUILD, not the dev server. Streaming, Server Actions and
     * the Node runtime all behave differently under `next dev`'s compiler, and
     * a suite that only ever exercised dev would not be evidence about what
     * gets deployed. `--turbopack` matches the build script.
     */
    command: `npm run build && npx next start --port ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...(process.env as Record<string, string>),
      /*
       * THE ONLY THING THE APP DOES DIFFERENTLY UNDER TEST.
       *
       * Points the model gateway at the local stub. There is no `if (isTest)`
       * anywhere in the model path — the pool, the failover rules, the `:free`
       * enforcement, the streaming and the citation validation are all the
       * shipping code. Only the socket on the far end is ours.
       */
      OPENROUTER_BASE_URL: modelStubUrl(),
      NEXT_PUBLIC_APP_URL: baseURL,
      BETTER_AUTH_URL: baseURL,
    },
  },
});
