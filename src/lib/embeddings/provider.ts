import { env } from "@/lib/env";

import { createLocalEmbeddingProvider } from "./local";
import type { EmbeddingProvider } from "./types";

/**
 * The provider registry.
 *
 * ┌───────────────────── THE SLOT FOR A SECOND PROVIDER ─────────────────────┐
 * │ There is exactly one implementation today and the interface exists so    │
 * │ that adding another is a file, not a refactor. To add one:               │
 * │                                                                          │
 * │   1. Write `src/lib/embeddings/<name>.ts` exporting a factory that       │
 * │      returns an `EmbeddingProvider`. Return L2-NORMALISED vectors — the  │
 * │      store uses cosine distance and assumes it.                          │
 * │   2. Add it to `PROVIDERS` below.                                        │
 * │   3. Add its name to the `EMBEDDING_PROVIDER` enum in `src/lib/env.ts`,  │
 * │      with any key it needs, and to `.env.example`.                       │
 * │                                                                          │
 * │ No call site changes, because no call site names a provider.             │
 * │                                                                          │
 * │ ONE HARD CONSTRAINT ON WHAT MAY GO HERE. This project runs on free tiers │
 * │ with no card on file, and an embedding provider is the easiest place to  │
 * │ break that by accident: ingestion embeds every chunk of every document,  │
 * │ so a metered embedder turns each upload into a bill. OpenAI, Voyage,     │
 * │ Cohere, and OpenRouter's /embeddings endpoint are all metered — there is │
 * │ no free model on any of them. None of them belong in this map.           │
 * │                                                                          │
 * │ A second provider is for a DIFFERENT LOCAL MODEL (a larger BGE, e5, or   │
 * │ a multilingual model), or for a self-hosted inference server. If the     │
 * │ local path ever becomes genuinely unworkable, that is a conversation to  │
 * │ have, not a paid API to quietly reach for.                               │
 * │                                                                          │
 * │ Whatever is added: switching providers means RE-INGESTING every          │
 * │ document. Vectors from two models are not comparable, and the pipeline   │
 * │ refuses to mix them rather than degrading quietly — see `space.ts`.      │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
const PROVIDERS: Record<
  typeof env.EMBEDDING_PROVIDER,
  () => EmbeddingProvider
> = {
  local: createLocalEmbeddingProvider,
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
