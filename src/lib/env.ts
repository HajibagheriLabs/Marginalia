/**
 * Server environment — every secret in the project.
 *
 * Parsed at module load, so a missing or malformed variable fails the process
 * at boot rather than at the first request that needs it.
 *
 * Import `env` from Server Components, Server Actions, and route handlers
 * ONLY. Client Components import `publicEnv` from `./env.public` instead —
 * that module is kept separate precisely so importing a public value can never
 * drag this one into the browser bundle.
 */
import { z } from "zod";

import { optional, parseOrThrow } from "./env.public";

export { publicEnv } from "./env.public";

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
      .min(
        32,
        "must be at least 32 characters; generate with `openssl rand -base64 32`",
      ),
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
    OPENAI_API_KEY: optional(z.string().min(1)),

    // Optional seeded account, so a reviewer can sign in without registering.
    DEMO_USER_EMAIL: optional(z.email()),
    DEMO_USER_PASSWORD: optional(z.string().min(8)),
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

type ServerEnv = z.infer<typeof serverSchema>;

/**
 * Guarded rather than lazily proxied: if this module is ever pulled into a
 * client bundle the failure is loud and immediate, which is what you want from
 * a file that holds every secret in the project.
 */
export const env: ServerEnv = (() => {
  if (typeof window !== "undefined") {
    throw new Error(
      "src/lib/env.ts was imported into the browser bundle. Server environment " +
        "variables are not available to Client Components — import publicEnv " +
        "from @/lib/env.public instead.",
    );
  }
  return parseOrThrow("server", serverSchema, process.env);
})();
