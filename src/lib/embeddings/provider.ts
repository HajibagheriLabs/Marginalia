import { env } from "@/lib/env";

import { createLocalEmbeddingProvider } from "./local";
import { createOpenRouterEmbeddingProvider } from "./openrouter";
import type { EmbeddingProvider } from "./types";

/**
 * The provider registry.
 *
 * ┌──────────────────────────── ADDING A PROVIDER ───────────────────────────┐
 * │   1. Write `src/lib/embeddings/<name>.ts` exporting a factory that       │
 * │      returns an `EmbeddingProvider`. Return L2-NORMALISED vectors — the  │
 * │      store uses cosine distance and assumes it.                          │
 * │   2. Add it to `PROVIDERS` below.                                        │
 * │   3. Add its name to the `EMBEDDING_PROVIDER` enum in `src/lib/env.ts`,  │
 * │      with any key it needs, and to `.env.example`.                       │
 * │                                                                          │
 * │ No call site changes, because no call site names a provider.             │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * THE ONE HARD CONSTRAINT: NOTHING METERED. This project runs on free tiers
 * with no card on file, and the embedder is the easiest place to break that by
 * accident — ingestion embeds every chunk of every document, so a metered
 * embedder turns each upload into a bill. That is a much larger exposure than
 * the chat pool, which spends one request per question.
 *
 * That constraint is about PRICE, not about hosting, and an earlier version of
 * this comment confused the two. It asserted that OpenRouter had no embedding
 * models at all. That was wrong: `GET /api/v1/models` lists only text, image
 * and audio output modalities, and embedding models are returned by
 * `GET /api/v1/models?output_modalities=embeddings` — 37 of them, several free.
 * The `:free` suffix rule in env.ts is what enforces the actual constraint, on
 * this provider exactly as it does on the chat pool.
 *
 * OpenAI, Voyage and Cohere are still excluded, on price: they are metered with
 * no free tier, and none of them belong in this map.
 *
 * WHATEVER IS ADDED, switching providers means RE-INGESTING EVERY DOCUMENT.
 * Vectors from two models are not comparable, and the dimension usually changes
 * too — bge is 384, `nvidia/nemotron-3-embed-1b:free` is 2048 — so it also
 * means a new Qdrant collection. The pipeline refuses to mix spaces rather than
 * degrading quietly; see `space.ts`.
 */
const PROVIDERS: Record<
  typeof env.EMBEDDING_PROVIDER,
  () => EmbeddingProvider
> = {
  local: createLocalEmbeddingProvider,
  openrouter: createOpenRouterEmbeddingProvider,
};

/**
 * The active provider, built once.
 *
 * Cached because the provider is a thin handle over module-level state and
 * there is no reason for a call site to hold one; asking for it each time is
 * simpler than threading it through, and costs nothing.
 */
let provider: EmbeddingProvider | null = null;

export function getEmbeddingProvider(): EmbeddingProvider {
  provider ??= PROVIDERS[env.EMBEDDING_PROVIDER]();
  return provider;
}

/**
 * The space the pipeline is currently writing into.
 *
 * This is what gets stamped onto `documents.embedding_model` and
 * `documents.embedding_dim` at ingest time, and what a search is checked
 * against before it runs.
 */
export function currentEmbeddingSpace(): {
  model: string;
  dimensions: number;
} {
  const active = getEmbeddingProvider();
  return { model: active.model, dimensions: active.dimensions };
}
