/**
 * The vector store boundary.
 *
 * ┌──────────────────────── THE SECURITY RULE ───────────────────────────────┐
 * │ A VECTOR SEARCH WITHOUT A PAYLOAD FILTER RETURNS OTHER USERS' DOCUMENTS. │
 * │                                                                          │
 * │ This is the defining security bug of retrieval-augmented applications,   │
 * │ and it is dangerous because of how it presents rather than how it works. │
 * │ There is no error. There is no stack trace. There is no failed request.  │
 * │ Nearest-neighbour search over a collection returns the nearest vectors   │
 * │ in that collection, and if the filter is missing, "that collection" is   │
 * │ every document belonging to every user of the application. The results   │
 * │ are well-formed. They are ranked. They are handed to a language model,   │
 * │ quoted back with citation markers, and rendered in a citation chip that  │
 * │ looks exactly like a correct one. One user reads another user's contract │
 * │ in an answer that appears to be working perfectly.                       │
 * │                                                                          │
 * │ It also cannot be caught by the kind of testing that catches most bugs.  │
 * │ Single-user development never sees it: with one user's data in the       │
 * │ collection, filtered and unfiltered search return identical results, so  │
 * │ every manual check passes and every screenshot looks right. The bug is   │
 * │ invisible until the moment there is a second user, at which point it is  │
 * │ a data breach rather than a defect.                                      │
 * │                                                                          │
 * │ THEREFORE: `userId` is a REQUIRED, non-optional parameter of `search`.   │
 * │ Not part of an options bag that could be forgotten, not defaulted, not   │
 * │ inferred from ambient context. The filter is constructed INSIDE the      │
 * │ single implementation of this interface. No call site builds a filter,   │
 * │ no call site can pass a raw Qdrant filter through, and there is no       │
 * │ escape hatch that takes one — because an escape hatch is the thing that  │
 * │ eventually gets used.                                                    │
 * │                                                                          │
 * │ `document_ids` is filtered too, and for a second reason: it arrives from │
 * │ the client as a conversation's scope. Filtering on user_id alone would   │
 * │ let a caller widen its own search to documents the user owns but did not │
 * │ select, which is not a breach but is still an answer citing a document   │
 * │ the user did not put in the room.                                        │
 * │                                                                          │
 * │ The isolation test in `qdrant.integration.test.ts` exists to keep this   │
 * │ true, and it asserts the hostile case specifically: user A searching     │
 * │ while explicitly asking for user B's document ids.                       │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * The interface exists so that swapping Qdrant for pgvector or Pinecone is one
 * new file plus one line in `index.ts`. It is deliberately narrow: four methods,
 * no query builder, no passthrough. A store that cannot express an unfiltered
 * search cannot accidentally perform one.
 */

/** What is stored alongside each vector. Small on purpose. */
export interface VectorPayload {
  /** THE OWNER. Every search filters on this. */
  user_id: string;
  /** The document this passage came from. Every search filters on this too. */
  document_id: string;
  /** The `chunks` row. The join key back to the text, which is NOT stored here. */
  chunk_id: string;
  /** Denormalised so the Evidence Rail can place a tick without a round trip. */
  page_from: number;
  page_to: number;
}

/**
 * One vector and its payload.
 *
 * `id` is the chunk's UUID. Qdrant accepts a UUID or an unsigned integer as a
 * point id, and reusing the chunk id makes upsert idempotent for free: re-running
 * the indexing stage overwrites the same points rather than duplicating them,
 * which is what lets the stage be re-run after a partial failure.
 */
export interface VectorPoint {
  id: string;
  vector: number[];
  payload: VectorPayload;
}

export interface VectorSearchParams {
  /**
   * THE OWNER, required. See the security rule above. This is the first
   * parameter because it is not optional in any sense — positional prominence
   * is a small thing, but it makes a call site missing it fail to compile.
   */
  userId: string;
  /** The conversation's document scope. Empty means nothing is in scope. */
  documentIds: string[];
  /** The query vector, L2-normalised, in the active embedding space. */
  vector: number[];
  limit: number;
  /** Drop results below this cosine score. Optional; no default filtering. */
  scoreThreshold?: number;
}

export interface VectorSearchHit {
  chunkId: string;
  documentId: string;
  pageFrom: number;
  pageTo: number;
  /** Cosine similarity. Higher is nearer, in [-1, 1] and in practice [0, 1]. */
  score: number;
}

export interface VectorStore {
  /**
   * Create the collection and its payload indexes if they do not exist.
   *
   * Idempotent, and safe to call on every boot. It does NOT migrate an existing
   * collection whose dimension disagrees with the current embedding config —
   * that situation means the model changed, and the answer is a new collection
   * and a re-ingest, not an in-place alteration.
   */
  ensureCollection(): Promise<void>;

  /** Insert or overwrite points by id. Idempotent per point. */
  upsert(points: VectorPoint[]): Promise<void>;

  /** Nearest neighbours, always filtered to `userId` and `documentIds`. */
  search(params: VectorSearchParams): Promise<VectorSearchHit[]>;

  /** Remove every point for one document. Used by delete and by re-ingest. */
  deleteByDocument(documentId: string): Promise<void>;

  /**
   * Remove every point belonging to one user. Used only by "delete all my
   * data".
   *
   * Present as its own method rather than as a loop over `deleteByDocument`
   * because the erasure has to be COMPLETE, and a loop is only as complete as
   * the list it iterates. A document row lost to a partial failure, or a point
   * whose document was hard-deleted at some point in the past, would survive
   * the loop and leave the user's text embedded in a shared collection after
   * they asked for it to be gone. One filter on `user_id` cannot miss a point
   * the loop never knew about.
   */
  deleteByUser(userId: string): Promise<void>;
}
