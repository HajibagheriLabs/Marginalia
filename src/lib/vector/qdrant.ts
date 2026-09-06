import { QdrantClient } from "@qdrant/js-client-rest";

import { env } from "@/lib/env";

import type {
  VectorPayload,
  VectorPoint,
  VectorSearchHit,
  VectorSearchParams,
  VectorStore,
} from "./types";

/**
 * QDRANT — the only implementation of `VectorStore`.
 *
 * READ THE SECURITY RULE AT THE TOP OF `types.ts` BEFORE EDITING THIS FILE.
 * In short: a vector search without a payload filter returns other users'
 * documents, silently, in results that look correct. `buildFilter` below is the
 * single place a filter is constructed, and `search` is the only path to the
 * Qdrant client from outside this module. Nothing here accepts a caller-supplied
 * filter, and nothing should be added that does.
 *
 * Note on the client API: `@qdrant/js-client-rest` v1.19 removed `search()` in
 * favour of the universal `query()` endpoint. The shape below is the current
 * one; older examples on the web will not compile.
 */

/** Payload fields that get an index. Both are filtered on every search. */
const INDEXED_PAYLOAD_FIELDS = ["user_id", "document_id"] as const;

/**
 * One client per process.
 *
 * Qdrant Cloud is a plain HTTPS service and the client is a thin wrapper over
 * fetch, so this is about not re-reading config rather than about pooling.
 */
let client: QdrantClient | null = null;

function getClient(): QdrantClient {
  client ??= new QdrantClient({
    url: env.QDRANT_URL,
    apiKey: env.QDRANT_API_KEY,
    // Qdrant Cloud's free tier can be slow to wake a sleeping cluster; the
    // default timeout is short enough to fail a cold first request.
    timeout: 20_000,
    checkCompatibility: false,
  });
  return client;
}

/**
 * THE FILTER. The one place it is built.
 *
 * `must` means AND: a point is returned only if it belongs to this user AND to
 * one of the documents in scope. The second clause is not redundant with the
 * first — see the security rule — and removing either one is a security change,
 * not a refactor.
 */
function buildFilter(userId: string, documentIds: string[]) {
  return {
    must: [
      { key: "user_id", match: { value: userId } },
      { key: "document_id", match: { any: documentIds } },
    ],
  };
}

/**
 * Whether the collection already exists with the right vector configuration.
 *
 * A dimension mismatch is reported rather than repaired. It means
 * EMBEDDING_MODEL changed under an existing index, and the only correct
 * response is a new collection plus a re-ingest — silently recreating the
 * collection here would delete every user's vectors on a boot after a config
 * edit, which is a far worse outcome than a loud failure.
 */
async function assertCompatibleCollection(name: string): Promise<void> {
  const info = await getClient().getCollection(name);
  const vectors = info.config?.params?.vectors;
  const size =
    typeof vectors === "object" && vectors !== null && "size" in vectors
      ? (vectors.size as number)
      : undefined;

  if (size !== undefined && size !== env.EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Qdrant collection "${name}" stores ${size}-dimensional vectors but ` +
        `EMBEDDING_DIMENSIONS is ${env.EMBEDDING_DIMENSIONS}. The embedding ` +
        `model changed under an existing index. Create a new collection and ` +
        `re-ingest; existing vectors cannot be converted.`,
    );
  }
}

export function createQdrantVectorStore(
  collection: string = env.QDRANT_COLLECTION,
): VectorStore {
  return {
    async ensureCollection(): Promise<void> {
      const qdrant = getClient();

      if (await qdrant.collectionExists(collection).then((r) => r.exists)) {
        await assertCompatibleCollection(collection);
      } else {
        await qdrant.createCollection(collection, {
          vectors: {
            size: env.EMBEDDING_DIMENSIONS,
            // Cosine, matching the L2-normalised vectors every provider
            // returns. With unit vectors this is equivalent to dot product,
            // but naming it Cosine keeps the store correct even if a future
            // provider forgets to normalise.
            distance: "Cosine",
          },
        });
      }

      // PAYLOAD INDEXES. Without them Qdrant still filters correctly, but it
      // does so by scanning: the filter is applied after the vector search
      // rather than being used to constrain it. On a collection holding every
      // user's chunks that degrades from milliseconds to seconds as the corpus
      // grows, and it degrades for everyone at once.
      //
      // Creating an index that exists is not an error, so this stays idempotent.
      for (const field of INDEXED_PAYLOAD_FIELDS) {
        await qdrant.createPayloadIndex(collection, {
          field_name: field,
          field_schema: "keyword",
          wait: true,
        });
      }
    },

    async upsert(points: VectorPoint[]): Promise<void> {
      if (points.length === 0) return;

      await getClient().upsert(collection, {
        // Block until the write is visible. The indexing stage marks a document
        // "ready" immediately afterwards, and a document that says ready but
        // returns nothing is worse than one that takes a moment longer.
        wait: true,
        points: points.map((point) => ({
          id: point.id,
          vector: point.vector,
          payload: { ...point.payload },
        })),
      });
    },

    async search(params: VectorSearchParams): Promise<VectorSearchHit[]> {
      const { userId, documentIds, vector, limit, scoreThreshold } = params;

      // Defence in depth. `userId` is typed as required, but a `string` can
      // still arrive empty from a caller that read it out of a stale session,
      // and an empty match value would filter on nothing.
      if (!userId) {
        throw new Error(
          "vector search called without a userId — refusing to run an unscoped search",
        );
      }

      // No documents in scope means no results, not "search everything". This
      // is the one place where returning an empty array is safer than throwing:
      // a conversation legitimately starts with nothing selected.
      if (documentIds.length === 0) return [];

      const response = await getClient().query(collection, {
        query: vector,
        filter: buildFilter(userId, documentIds),
        limit,
        score_threshold: scoreThreshold,
        with_payload: true,
        // The vectors themselves are never needed back — the text lives in
        // Postgres and is fetched by chunk_id. Not requesting them keeps the
        // response small.
        with_vector: false,
      });

      return response.points.map((point) => {
        const payload = point.payload as unknown as VectorPayload;
        return {
          chunkId: payload.chunk_id,
          documentId: payload.document_id,
          pageFrom: payload.page_from,
          pageTo: payload.page_to,
          score: point.score,
        };
      });
    },

    async deleteByDocument(documentId: string): Promise<void> {
      // Filtered on document_id alone, and that is correct here rather than an
      // omission: a document id is a server-generated UUID that reached this
      // call from an ownership-checked row, not a value a client chose. That is
      // the opposite of `search`, whose document ids come straight off a
      // request body — which is exactly why that one is also scoped by user.
      await getClient().delete(collection, {
        wait: true,
        filter: {
          must: [{ key: "document_id", match: { value: documentId } }],
        },
      });
    },

    async deleteByUser(userId: string): Promise<void> {
      // Defence in depth, exactly as in `search`: an empty user id would build
      // a filter that matches nothing in Qdrant's semantics — or, on a future
      // client that treats it as absent, EVERY point in a shared collection.
      // A delete is not the operation to find out which.
      if (!userId) {
        throw new Error(
          "vector deleteByUser called without a userId — refusing to run an unscoped delete",
        );
      }

      await getClient().delete(collection, {
        wait: true,
        filter: {
          must: [{ key: "user_id", match: { value: userId } }],
        },
      });
    },
  };
}
