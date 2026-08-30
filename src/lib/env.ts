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
    // Tried in order when the primary model is rate-limited or unavailable.
    // Comma-separated in the environment; an array everywhere else.
    OPENROUTER_FALLBACK_MODELS: z
      .string()
      .default("")
      .transform((value) =>
        value
          .split(",")
          .map((slug) => slug.trim())
          .filter(Boolean),
      ),

    // Embeddings, behind the EmbeddingProvider interface.
    //
    // `local` runs the model in this Node process via Transformers.js: no API
    // call, no key, no per-token cost, nothing metered. It is the only value
    // this enum accepts, and that is enforcement rather than documentation —
    // ingestion embeds every chunk of every upload, so a metered embedder
    // turns each document into a bill, and this project runs on free tiers
    // with no card on file. Adding a provider means adding it here AND to the
    // registry in src/lib/embeddings/provider.ts, which spells out what may
    // and may not go in it.
    //
    // Changing EMBEDDING_MODEL means RE-INGESTING every document, not editing
    // this value in place — embedding spaces are never mixed, and the
    // dimension is part of the space.
    EMBEDDING_PROVIDER: z.enum(["local"]).default("local"),
    EMBEDDING_MODEL: z.string().min(1).default("Xenova/bge-small-en-v1.5"),
    EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(384),

    // Where Transformers.js caches the downloaded model weights.
    //
    // Its default lives inside node_modules, which is READ-ONLY on Vercel. The
    // local provider falls back to /tmp there — the only writable path in a
    // function, and one that survives for the life of a warm instance. Set
    // this explicitly for a container deployment with a real volume.
    TRANSFORMERS_CACHE_DIR: optional(z.string().min(1)),

    // Optional seeded account, so a reviewer can sign in without registering.
    DEMO_USER_EMAIL: optional(z.email()),
    DEMO_USER_PASSWORD: optional(z.string().min(8)),
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
