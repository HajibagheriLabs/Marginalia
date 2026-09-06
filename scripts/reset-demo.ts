import { loadLocalEnv } from "@/lib/env.file";

/**
 * `npm run db:reset-demo` — put the demo workspace back the way the seed left
 * it, without re-ingesting anything.
 *
 * Same two-file shape as the seed and the eval CLI: the environment has to
 * reach `process.env` before anything that reads `src/lib/env.ts` is imported,
 * and a static import would be hoisted above this call.
 */
loadLocalEnv();

void import("./reset-demo-main");
