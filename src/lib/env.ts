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
    // this one; file bytes never pass through an API route on the way IN. On
    // the way out they do: the store is configured for private access, so
    // /api/documents/[documentId]/file reads with this token and streams the
    // result behind the same ownership check as everything else.
    BLOB_READ_WRITE_TOKEN: z.string().min(1),

    /**
     * An origin that serves document files instead of Vercel Blob.
     *
     * Normally UNSET, and every real deployment leaves it that way.
     *
     * It exists for the end-to-end suite, which needs a real PDF the browser
     * can fetch through this application without a Blob token — a secret CI
     * does not have and should not need. Same rule as OPENROUTER_BASE_URL: an
     * operator-configured override rather than an `if (isTest)`, so the route,
     * the ownership check, the response headers and the viewer are all the
     * shipping code path. See src/lib/blob.ts for the origin comparison and
     * why it is parsed rather than prefix-matched.
     */
    BLOB_FIXTURE_ORIGIN: optional(z.url()),

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
    /**
     * Where the gateway lives. Blank means OpenRouter itself.
     *
     * Exists for ONE reason: the end-to-end suite points it at a local stub
     * that speaks the same chat-completions SSE format, so a browser test can
     * assert streaming, citation markers and the trace without spending a
     * request from a 50/day shared pool — and without going red on a day the
     * upstream free pool is exhausted, which would make the suite a weather
     * report rather than a test.
     *
     * It is an override rather than a test-only branch on purpose: there is no
     * `if (isTest)` anywhere in the model path, so the code the E2E suite
     * exercises is the code that ships. The `:free` rule still applies to every
     * model id regardless of where this points.
     */
    OPENROUTER_BASE_URL: optional(z.url()),
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
    // `local` is the DEFAULT and the shipped configuration: the model runs in
    // this Node process via Transformers.js, so there is no API call, no key,
    // no per-token cost and nothing to rate-limit.
    //
    // `openrouter` calls POST /api/v1/embeddings. It exists because the
    // interface deserves a second real implementation and because a deployment
    // without the memory or cold-start budget for in-process inference needs
    // somewhere to go. An earlier version of this comment claimed OpenRouter had
    // no embedding models; that was wrong, and the mistake is worth naming
    // precisely so it is not repeated. `GET /api/v1/models` returns only models
    // whose OUTPUT MODALITY is text, image or audio. Embedding models are behind
    // `?output_modalities=embeddings` (37 of them) and rerankers behind
    // `?output_modalities=rerank` (7). A filtered listing is evidence about the
    // filter before it is evidence about the catalogue.
    //
    // THE COST RULE IS UNCHANGED AND IS ENFORCED BELOW: with `openrouter`,
    // EMBEDDING_MODEL must end in `:free`. Ingestion embeds every chunk of every
    // upload, so a metered embedder is a per-document bill — a far bigger
    // exposure than the chat pool's one request per question.
    //
    // Changing EMBEDDING_MODEL means RE-INGESTING every document, not editing
    // this value in place. Embedding spaces are never mixed and the dimension is
    // part of the space — bge is 384, nvidia/nemotron-3-embed-1b:free is 2048 —
    // so a provider switch is also a new QDRANT_COLLECTION.
    EMBEDDING_PROVIDER: z.enum(["local", "openrouter"]).default("local"),
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
    // `openrouter` calls POST /api/v1/rerank with the free
    // nvidia/llama-nemotron-rerank-vl-1b-v2:free. This corrects an earlier
    // claim here that no hosted option existed — see the EMBEDDING_PROVIDER
    // note above for how that mistake was made.
    //
    // ITS SCORES ARE ON A DIFFERENT SCALE, which is the part that matters.
    // `local` returns raw logits with the relevant/irrelevant boundary at 0;
    // the hosted one returns a probability in (0, 1), where a floor of 0 would
    // admit EVERY passage and silently delete the relevance floor. Each
    // implementation therefore carries its own `scoreFloor` and retrieve()
    // defaults to it. See src/lib/retrieval/rerank-openrouter.ts for the
    // measured distribution behind 0.02.
    RETRIEVAL_RERANKER: z.enum(["off", "local", "openrouter"]).default("local"),
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
  })
  /*
   * ┌────────────────────────────────────────────────────────────────────────┐
   * │ THE `:free` RULE, EXTENDED TO THE HOSTED EMBEDDER AND RERANKER.        │
   * │                                                                        │
   * │ Field-level refinements cannot express this: whether EMBEDDING_MODEL   │
   * │ must end in `:free` depends on EMBEDDING_PROVIDER, and a `.refine()`   │
   * │ on a single field cannot see a sibling. So it is checked on the object,│
   * │ still at boot, still before a single request can be made.              │
   * │                                                                        │
   * │ WHY IT MATTERS MORE HERE THAN FOR CHAT. The chat pool spends one       │
   * │ request per question, and a mistake there shows up as a small invoice. │
   * │ The EMBEDDER runs over every chunk of every document — one upload of a │
   * │ 300-page PDF is thousands of metered calls before anybody has asked    │
   * │ anything. That is the one place where a config typo turns into real    │
   * │ money fast, so it refuses to boot rather than refusing at request time.│
   * └────────────────────────────────────────────────────────────────────────┘
   */
  .superRefine((value, ctx) => {
    if (value.EMBEDDING_PROVIDER === "openrouter") {
      if (!value.EMBEDDING_MODEL.endsWith(":free")) {
        ctx.addIssue({
          code: "custom",
          path: ["EMBEDDING_MODEL"],
          message:
            "must end in `:free` when EMBEDDING_PROVIDER=openrouter — ingestion " +
            "embeds every chunk of every document, so a metered embedder is a " +
            "bill per upload. Free embedding models: " +
            "https://openrouter.ai/api/v1/models?output_modalities=embeddings",
        });
      }
      // The local provider needs no key, so this is only required here.
      if (!value.OPENROUTER_API_KEY) {
        ctx.addIssue({
          code: "custom",
          path: ["OPENROUTER_API_KEY"],
          message: "is required when EMBEDDING_PROVIDER=openrouter",
        });
      }
      // A local model id under the hosted provider, or the reverse, is the
      // realistic typo: both are non-empty strings and neither schema notices.
      if (value.EMBEDDING_MODEL.startsWith("Xenova/")) {
        ctx.addIssue({
          code: "custom",
          path: ["EMBEDDING_MODEL"],
          message:
            "looks like a Transformers.js model id but EMBEDDING_PROVIDER is " +
            "`openrouter`. Set EMBEDDING_PROVIDER=local, or use an OpenRouter slug.",
        });
      }
    }

    if (value.RETRIEVAL_RERANKER === "openrouter") {
      if (!value.RETRIEVAL_RERANK_MODEL.endsWith(":free")) {
        ctx.addIssue({
          code: "custom",
          path: ["RETRIEVAL_RERANK_MODEL"],
          message:
            "must end in `:free` when RETRIEVAL_RERANKER=openrouter. Free " +
            "rerankers: https://openrouter.ai/api/v1/models?output_modalities=rerank",
        });
      }
      if (!value.OPENROUTER_API_KEY) {
        ctx.addIssue({
          code: "custom",
          path: ["OPENROUTER_API_KEY"],
          message: "is required when RETRIEVAL_RERANKER=openrouter",
        });
      }
      if (value.RETRIEVAL_RERANK_MODEL.startsWith("Xenova/")) {
        ctx.addIssue({
          code: "custom",
          path: ["RETRIEVAL_RERANK_MODEL"],
          message:
            "looks like a Transformers.js model id but RETRIEVAL_RERANKER is " +
            "`openrouter`. Set RETRIEVAL_RERANKER=local, or use an OpenRouter slug.",
        });
      }
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
