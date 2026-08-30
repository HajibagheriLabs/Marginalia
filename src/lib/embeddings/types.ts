/**
 * The embedding boundary.
 *
 * Everything downstream — ingestion, retrieval, the eval harness — talks to
 * this interface and never to a model. That is what makes the local model an
 * implementation detail rather than an architectural commitment: swapping it
 * means writing one file and changing one env var, not touching call sites.
 *
 * Two properties are part of the contract and are not incidental:
 *
 *   - `model` and `dimensions` are READ BY THE PIPELINE, not just declared.
 *     They are written onto every document row at ingest time and compared
 *     before any multi-document search. See `assertSameEmbeddingSpace`.
 *   - Vectors come back L2-NORMALISED. The vector store uses cosine distance,
 *     and pre-normalising means a dot product is the cosine, which is what
 *     Qdrant is actually computing. A provider that returns unnormalised
 *     vectors would produce scores that look plausible and rank wrongly.
 */

/**
 * Which embedding space a set of vectors lives in.
 *
 * A space is the PAIR. Two models that both output 384 dimensions do not share
 * a space, and the dimension alone is never enough to decide comparability.
 */
export interface EmbeddingSpace {
  /** The model identifier, exactly as recorded on `documents.embedding_model`. */
  model: string;
  /** Vector length, recorded on `documents.embedding_dim`. */
  dimensions: number;
}

export interface EmbeddingProvider extends EmbeddingSpace {
  /**
   * Embed passages for storage.
   *
   * Takes an array because batching is the provider's business, not the
   * caller's: the local provider batches to bound memory, and a hosted one
   * would batch to bound request size. Order is preserved — `result[i]` is the
   * vector for `texts[i]` — because call sites zip the output back against
   * chunk rows.
   *
   * The text passed here is the AUGMENTED text from `embeddingText()`, with the
   * document title and section breadcrumb prepended. Never the stored text.
   */
  embedDocuments(texts: string[]): Promise<number[][]>;

  /**
   * Embed a question for search.
   *
   * Separate from `embedDocuments` because for asymmetric models the two are
   * genuinely different operations, not a convenience wrapper. See the prefix
   * comment in the local provider — this is the whole reason the interface has
   * two methods instead of one.
   */
  embedQuery(text: string): Promise<number[]>;
}

/** Something the embedder refused or could not do. Safe to show a user. */
export class EmbeddingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EmbeddingError";
  }
}
