import { createQdrantVectorStore } from "./qdrant";
import type { VectorStore } from "./types";

/**
 * The vector store's public surface.
 *
 * Call sites import `getVectorStore()` from `@/lib/vector` and never construct
 * a client. Swapping Qdrant for pgvector or Pinecone is a new file next to
 * `qdrant.ts` plus the one line below.
 *
 * READ `types.ts` BEFORE USING THIS. `search()` takes `userId` as a required
 * parameter and builds the payload filter itself; nothing here exposes a raw
 * client or accepts a caller-supplied filter, and that is the whole point.
 */

export type {
  VectorPayload,
  VectorPoint,
  VectorSearchHit,
  VectorSearchParams,
  VectorStore,
} from "./types";

export { createQdrantVectorStore } from "./qdrant";

let store: VectorStore | null = null;

export function getVectorStore(): VectorStore {
  store ??= createQdrantVectorStore();
  return store;
}
