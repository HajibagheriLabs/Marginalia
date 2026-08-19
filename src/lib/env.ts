/**
 * Typed, validated environment.
 *
 * Both schemas are parsed at module load, so a missing or malformed variable
 * fails the process at boot rather than at the first request that needs it.
 *
 * Two schemas, because they sit on different sides of a trust boundary:
 *   - `serverSchema` holds secrets and is parsed only on the server.
 *   - `clientSchema` holds NEXT_PUBLIC_* values that Next.js inlines into the
 *     browser bundle. Those must be read as literal `process.env.FOO` property
 *     accesses for the inlining to happen — never `process.env[someKey]`.
 *
 * Import `env` from Server Components, Server Actions, and route handlers.
 * Import `publicEnv` from anywhere, including Client Components.
 */
import { z } from "zod";

/** Postgres connection strings are URLs, but not http(s) ones. */
const postgresUrl = z
  .string()
  .min(1)
  .refine(
    (value) => /^postgres(ql)?:\/\//.test(value),
    "must start with postgres:// or postgresql://",
  );

const serverSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),

    // Postgres (Neon): documents, pages, chunk text, the lexical tsvector,
    // conversations, messages, citations, retrieval traces, and job state.
    DATABASE_URL: postgresUrl,

    // Better Auth — email + password. One user owns their documents.
    BETTER_AUTH_SECRET: z
      .string()
      .min(32, "must be at least 32 characters; generate with `openssl rand -base64 32`"),
    BETTER_AUTH_URL: z.url(),

    // Vercel Blob. Uploads go client-side with a short-lived token minted from
    // this one; file bytes never pass through an API route.
    BLOB_READ_WRITE_TOKEN: z.string().min(1),

    // Qdrant Cloud — embeddings plus a small payload.
    QDRANT_URL: z.url(),
    QDRANT_API_KEY: z.string().min(1),
    QDRANT_COLLECTION: z.string().min(1).default("marginalia_chunks"),

    // Model gateway.
    OPENROUTER_API_KEY: z.string().min(1),
    OPENROUTER_MODEL: z.string().min(1).default("anthropic/claude-sonnet-5"),

    // Embeddings, behind the EmbeddingProvider interface. Changing the model
    // means re-ingesting every document, not editing this value in place —
    // embedding spaces are never mixed.
    EMBEDDING_PROVIDER: z.enum(["openai"]).default("openai"),
    EMBEDDING_MODEL: z.string().min(1).default("text-embedding-3-small"),
    OPENAI_API_KEY: z.string().min(1).optional(),

    // Optional seeded account, so a reviewer can sign in without registering.
    DEMO_USER_EMAIL: z.email().optional(),
    DEMO_USER_PASSWORD: z.string().min(8).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.EMBEDDING_PROVIDER === "openai" && !value.OPENAI_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["OPENAI_API_KEY"],
        message: "is required when EMBEDDING_PROVIDER is openai",
      });
    }
  });

const clientSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.url(),
});

type ServerEnv = z.infer<typeof serverSchema>;
type ClientEnv = z.infer<typeof clientSchema>;

/** Turn a ZodError into something readable in a terminal, then throw. */
function parseOrThrow<T>(
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

/** Safe to read from anywhere, including Client Components. */
export const publicEnv: ClientEnv = parseOrThrow("public", clientSchema, {
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
});

/**
 * Server-only environment. Guarded rather than lazily proxied: if this module
 * is ever pulled into a client bundle the failure is loud and immediate, which
 * is what you want from a file that holds every secret in the project.
 */
export const env: ServerEnv = (() => {
  if (typeof window !== "undefined") {
    throw new Error(
      "src/lib/env.ts was imported into the browser bundle. Server environment " +
        "variables are not available to Client Components — import publicEnv instead.",
    );
  }
  return parseOrThrow("server", serverSchema, process.env);
})();
