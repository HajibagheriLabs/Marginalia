import path from "node:path";

import { loadEnvFile } from "@/lib/env.file";

/**
 * Load `.env.local` into `process.env` before any test module is imported.
 *
 * `src/lib/env.ts` parses the environment at module load and throws on a
 * missing variable, so anything importing it transitively — the vector store,
 * the embedding provider, the database — is unimportable in a test process that
 * has not been given an environment.
 *
 * The parser itself lives in src/lib/env.file.ts, shared with the eval harness,
 * which needs exactly the same bootstrap for exactly the same reason.
 */
loadEnvFile(path.join(process.cwd(), ".env.local"));
