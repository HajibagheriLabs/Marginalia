import { loadLocalEnv } from "@/lib/env.file";

/**
 * The eval entry point, and nothing else.
 *
 * `src/lib/env.ts` parses the environment AT MODULE LOAD and throws on a
 * missing variable, so `.env.local` has to be in `process.env` before anything
 * that reaches it is imported. A static `import "./main"` at the top of this
 * file would be hoisted above the `loadLocalEnv()` call by the module system
 * and the harness would fail to boot with a wall of Zod issues about variables
 * that are sitting in a file in the project root.
 *
 * Hence two files: this one loads the environment, then pulls in the harness
 * dynamically. It is the same reason `vitest.setup.ts` exists as a separate
 * setup file rather than a few lines at the top of a test.
 */
loadLocalEnv();

void import("./main");
