import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Load `.env.local` into `process.env` before any test module is imported.
 *
 * `src/lib/env.ts` parses the environment at module load and throws on a
 * missing variable, so anything importing it transitively — the vector store,
 * the embedding provider, the database — is unimportable in a test process that
 * has not been given an environment. Vite does read `.env` files, but only
 * exposes `VITE_`-prefixed values on `import.meta.env`; it never populates
 * `process.env`, which is what Zod is reading.
 *
 * Hand-rolled rather than pulling in `dotenv`: the format needed here is
 * `KEY=value` with optional quotes and `#` comments, and a fifteen-line parser
 * is a smaller liability than a dependency that only exists in tests.
 *
 * Existing values always win, so CI can inject secrets normally and a developer
 * can override one for a single run without editing the file.
 */
function loadEnvFile(relativePath: string): void {
  const path = fileURLToPath(new URL(relativePath, import.meta.url));
  if (!existsSync(path)) return;

  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
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

loadEnvFile("./.env.local");
