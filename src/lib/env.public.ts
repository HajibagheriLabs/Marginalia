/**
 * Client-safe environment.
 *
 * This module is deliberately SEPARATE from env.ts. Client Components that
 * need a public value import from here, so they never pull the server schema —
 * and every secret alongside it — into the browser bundle.
 *
 * NEXT_PUBLIC_* values must be read as literal `process.env.FOO` property
 * accesses for Next.js to inline them at build time. Never `process.env[key]`.
 */
import { z } from "zod";

/**
 * An optional variable that may also be present but blank.
 *
 * `FOO=` in a .env file sets FOO to the empty string, not to undefined, so a
 * plain `.optional()` would reject a variable the user deliberately left
 * blank. Treat empty as absent.
 */
export function optional<T extends z.ZodType>(schema: T) {
  return z.preprocess(
    (value) => (value === "" ? undefined : value),
    schema.optional(),
  );
}

/** Turn a ZodError into something readable in a terminal, then throw. */
export function parseOrThrow<T>(
  scope: string,
  schema: z.ZodType<T>,
  source: unknown,
): T {
  const result = schema.safeParse(source);
  if (result.success) return result.data;

  const lines = result.error.issues.map(
    (issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`,
  );
  throw new Error(
    `Invalid ${scope} environment variables:\n${lines.join("\n")}\n\n` +
      "Copy .env.example to .env.local and fill in the missing values.",
  );
}

const clientSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.url(),
});

/** Safe to read from anywhere, including Client Components. */
export const publicEnv = parseOrThrow("public", clientSchema, {
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
});
