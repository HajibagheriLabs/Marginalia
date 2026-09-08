/**
 * The embeddings module's public surface.
 *
 * A barrel and nothing else — no logic lives here, so that `space.ts` can
 * depend on the registry in `provider.ts` without the two importing each other.
 *
 * Call sites should import from `@/lib/embeddings` rather than reaching into
 * `./local` directly. The point of the interface is that no caller names a
 * model, and an import path is a way of naming one.
 */

export type { EmbeddingProvider, EmbeddingSpace } from "./types";
export { EmbeddingError } from "./types";

export { getEmbeddingProvider, currentEmbeddingSpace } from "./provider";

export {
  EmbeddingSpaceError,
  assertSameEmbeddingSpace,
  sameSpace,
} from "./space";

// Exported for the ingestion stage, which needs the batch size to decide how
// much work to take per invocation, and for tests.
export { LOCAL_EMBEDDING } from "./local";
export { OPENROUTER_EMBEDDING } from "./openrouter";
