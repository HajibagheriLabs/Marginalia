import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Load a `.env` file into `process.env`.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHO NEEDS THIS, AND WHO DOES NOT
 *
 * Not the application. Next.js reads `.env.local` itself before any module in
 * `src/` is evaluated, so nothing under `src/app` or `src/server` has ever had
 * to think about it.
 *
 * What needs it is every process that runs this codebase WITHOUT Next.js: the
 * Vitest workers and the eval harness. `src/lib/env.ts` parses the environment
 * at module load and throws on a missing variable, so anything that transitively
 * imports it — the database client, the vector store, the embedding provider —
 * is unimportable in a bare Node process that has not been handed an
 * environment. The failure is a wall of Zod issues about variables that are
 * sitting in a file three directories up.
 *
 * Vite does read `.env` files, but only exposes `VITE_`-prefixed values on
 * `import.meta.env`; it never populates `process.env`, which is what Zod reads.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY IT IS HAND-ROLLED
 *
 * The format needed here is `KEY=value` with optional surrounding quotes and
 * `#` comments. Twenty lines of parsing is a smaller liability than a
 * dependency that exists only outside the application — and this one has to be
 * importable before anything else, which is a bad place to have a package that
 * can break.
 *
 * EXISTING VALUES ALWAYS WIN. CI injects secrets as real environment variables,
 * and a developer overriding one for a single run — `RETRIEVAL_RERANKER=local
 * npm run eval` — must not have the file quietly overwrite it.
 */
export function loadEnvFile(file: string): void {
  if (!existsSync(file)) return;

  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    if (!key || key in process.env) continue;

    let value = line.slice(separator + 1).trim();
    // Strip one matching pair of surrounding quotes, if present.
    if (
      value.length >= 2 &&
      (value.startsWith('"') || value.startsWith("'")) &&
      value.endsWith(value[0])
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

/**
 * The project's `.env.local`, found from the working directory.
 *
 * `process.cwd()` rather than a path relative to this module: npm scripts run
 * from the package root, which is where the file is, and resolving from the
 * module's own location breaks the moment this file moves.
 */
export function loadLocalEnv(): void {
  loadEnvFile(path.join(process.cwd(), ".env.local"));
}
