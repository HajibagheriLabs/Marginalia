import { loadLocalEnv } from "@/lib/env.file";

/**
 * `npm run db:seed` — the one-click demo, built end to end.
 *
 * The environment has to be in `process.env` before anything that reads
 * `src/lib/env.ts` is imported, and a static import would be hoisted above this
 * call. Same two-file shape as the eval CLI, for the same reason.
 */
loadLocalEnv();

void import("./seed-main");
