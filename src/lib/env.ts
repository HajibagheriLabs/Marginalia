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

/**
 * An OpenRouter model id this project is allowed to call.
 *
 * The `:free` suffix is OpenRouter's own marker for a zero-cost variant, and it
 * is the only thing standing between a config typo and a bill. Checked as a
 * suffix rather than against a hard-coded allowlist because the free pool
 * changes weekly — an allowlist would be stale within a month and would start
 * rejecting models that are perfectly free.
 */
const freeModelId = z
  .string()
  .min(1)
  .refine(
    (value) => value.endsWith(":free"),
    "must be an OpenRouter model id ending in `:free` — this project runs at " +
      "zero cost with no card on file. See https://openrouter.ai/models?max_price=0",
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
    //
    // EVERY MODEL ID MUST END IN `:free`, and that is checked HERE rather than
    // at request time. This project runs with no card on file, and OpenRouter
    // bills a paid model the moment it is called — by which point the money is
    // spent and the only signal is an invoice. A typo in a model slug, or a
    // copied-in example from the docs, is the whole failure mode. Refusing to
    // boot is loud, immediate, and free; refusing at request time is neither
    // of the first two.
    //
    // The live list of free models is at https://openrouter.ai/models?max_price=0
    // (or GET https://openrouter.ai/api/v1/models, filtering `id` on the
    // `:free` suffix). It CHANGES — models are delisted without notice — which
    // is why there is a fallback list at all.
    OPENROUTER_API_KEY: z.string().min(1),
    OPENROUTER_MODEL: freeModelId.default("nvidia/nemotron-3.5-lightning:free"),
    // Tried in order when the primary model is delisted, rate-limited, or
    // erroring. Comma-separated in the environment; an array everywhere else.
    OPENROUTER_FALLBACK_MODELS: z
      .string()
      .default(
        "google/gemma-4-31b-it:free,nvidia/nemotron-3-super-120b-a12b:free",
      )
      .transform((value) =>
        value
          .split(",")
          .map((slug) => slug.trim())
          .filter(Boolean),
      )
      .pipe(z.array(freeModelId)),

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

    // ── RERANKING ──────────────────────────────────────────────────────────
    //
    // ON BY DEFAULT, and that default was earned rather than assumed. It used
    // to be off, with a comment saying it should stay workable off until
    // something measured it. The eval harness measured it, over 38 answerable
    // questions on the corpus in evals/dataset/:
    //
    //     recall@5   86.8% -> 92.1%     (+5.3 points)
    //     MRR        0.736 -> 0.788     (+0.053)
    //     recall@10  97.4% -> 94.7%     (-2.6 points; one question fell out)
    //     retrieval  2.9 s -> 5.0 s p50 (+2.1 s)
    //
    // The trade is ordering quality against latency, and it is worth taking
    // because the failures it fixes are the expensive kind: two of the three
    // questions the system wrongly declined were declined precisely because the
    // answering passage sat outside the top 8 it was shown. Reproduce with
    // `npm run eval -- --compare baseline-retrieval rerank-on`, and turn it off
    // with RETRIEVAL_RERANKER=off — it must stay workable off, which the
    // harness checks on every run that passes --no-rerank.
    //
    // `local` runs the cross-encoder Xenova/ms-marco-MiniLM-L-6-v2 in this
    // process, the same way embeddings do.
    //
    // THERE IS NO HOSTED OPTION, and not for lack of looking. Every commercial
    // reranking API is metered, and this project runs with no card on file.
    // OpenRouter — the one gateway this app already talks to — has no reranking
    // and no embedding models at all: its catalogue is 431 models whose output
    // modalities are text, image, and audio, with nothing that returns a vector
    // or a relevance score. Checked against GET https://openrouter.ai/api/v1/models.
    // So "use a free hosted reranker" is not a configuration this project
    // declined to add; it is not on offer.
    RETRIEVAL_RERANKER: z.enum(["off", "local"]).default("local"),
    RETRIEVAL_RERANK_MODEL: z
      .string()
      .min(1)
      .default("Xenova/ms-marco-MiniLM-L-6-v2"),

    // Rewrites a pronoun-laden follow-up ("what about the second one?") into a
    // standalone query before retrieval. Costs one extra model round trip per
    // turn, which is why it is measured before it is trusted.
    RETRIEVAL_QUERY_REWRITE: z.enum(["off", "on"]).default("off"),

    // Shared secret the ingestion route requires.
    //
    // The pipeline re-invokes itself over HTTP when a document needs more time
    // than one function invocation allows, so that route is reachable from the
    // internet and carries no user session. Without a secret it would be an
    // unauthenticated endpoint that runs CPU-heavy work on demand for anyone
    // who learns a document id — a way to burn the whole compute budget from
    // outside. Generate with `openssl rand -base64 32`.
    INGEST_SECRET: z
      .string()
      .min(16, "must be at least 16 characters; generate with `openssl rand -base64 32`"),

    // Where Transformers.js caches the downloaded model weights.
    //
    // Its default lives inside node_modules, which is READ-ONLY on Vercel. The
    // local provider falls back to /tmp there — the only writable path in a
    // function, and one that survives for the life of a warm instance. Set
    // this explicitly for a container deployment with a real volume.
    TRANSFORMERS_CACHE_DIR: optional(z.string().min(1)),

    /**
     * The demo account's password.
     *
     * PUBLISHED, NOT SECRET. `/demo` hands out a session for it to anyone who
     * asks, and the README prints it. It lives in the environment rather than
     * in source anyway, for two reasons: a deployment that has not been seeded
     * should not appear to have a working demo, and rotating it should be an
     * env change plus a re-seed rather than a commit.
     *
     * The demo account's EMAIL is not here — it is a constant in
     * src/lib/demo.ts, alongside the fixed user id, because three separate
     * places have to agree on it and a configurable identity would be three
     * places that can disagree.
     *
     * Optional: an unseeded deployment is a valid deployment. `/demo` answers
     * 503 with the command that fixes it rather than pretending.
     */
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
