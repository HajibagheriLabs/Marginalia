/**
 * THE RETRIEVAL BOUNDARY.
 *
 * Everything the generation step is allowed to know about how a passage was
 * found. Two things travel out of this module and they serve different
 * audiences:
 *
 *   - `RetrievedPassage[]` — the context the model sees, in order, numbered.
 *   - `RetrievalCandidate[]` — the trace: every candidate either channel
 *     surfaced, with its rank and score in each, its fused score, its rerank
 *     score, and whether it made the final cut.
 *
 * The trace is a PRODUCT FEATURE, not a debug log. It is persisted to the
 * `retrievals` table and rendered under every answer as the "Show retrieval"
 * table. That changes what it has to be: complete rather than convenient,
 * stable rather than tweakable, and honest about the passages that were found
 * and rejected — those are the interesting rows, because they are where a
 * disappointing answer is explained.
 *
 * The field names here line up one-to-one with the `retrievals` columns on
 * purpose. A trace that needed reshaping before it could be stored would drift
 * from what was actually used the first time either side changed.
 */

/** Which channel found a candidate. Both is the good case. */
export type RetrievalChannel = "dense" | "lexical" | "both";

/**
 * One candidate passage and the complete record of how it scored.
 *
 * Ranks are 1-BASED and null when the channel did not return the passage at
 * all. Null is not zero: "the lexical channel ranked this 40th" and "the
 * lexical channel never saw this" are different facts, and collapsing them
 * would make the trace lie in exactly the case it exists to explain.
 */
export interface RetrievalCandidate {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  ordinal: number;
  text: string;
  tokenCount: number;
  pageFrom: number;
  pageTo: number;
  charStart: number;
  charEnd: number;
  sectionPath: string | null;

  /** 1-based position in the dense channel, or null if it was not returned. */
  denseRank: number | null;
  /** Cosine similarity, roughly 0–1. */
  denseScore: number | null;
  /** 1-based position in the lexical channel, or null. */
  lexicalRank: number | null;
  /** `ts_rank_cd` output. Unbounded above and NOT comparable to a cosine. */
  lexicalScore: number | null;

  /** Reciprocal Rank Fusion score. The ranking signal when reranking is off. */
  rrfScore: number;
  /** Which channels found it. */
  channel: RetrievalChannel;

  /**
   * Cross-encoder logit, or null when reranking is off or the candidate was
   * outside the rerank window. Unbounded; roughly, above 0 is relevant.
   */
  rerankScore: number | null;

  /** True when this candidate's text reached the model. */
  used: boolean;
}

/**
 * A passage as the generation step receives it.
 *
 * `marker` is the number the model is told to cite — [1], [2] — and is the
 * index into this array plus one. It is assigned here rather than by the
 * prompt builder so that the trace, the citations, and the context all agree
 * on which passage is which.
 *
 * `chunkIds` is a LIST because adjacent chunks are merged before they are
 * handed over: the 15% ingest overlap means neighbouring chunks literally
 * share sentences, and passing both would spend context on a repeat and invite
 * the model to cite the same text twice under two numbers. `primaryChunkId` is
 * the highest-ranked constituent and is what a citation resolves to.
 */
export interface RetrievedPassage {
  /** 1-based citation marker. */
  marker: number;
  /** Every chunk merged into this passage, in document order. */
  chunkIds: string[];
  /** The best-ranked constituent — what a citation for this marker points at. */
  primaryChunkId: string;
  documentId: string;
  documentTitle: string;
  /** The passage text, in the document's own words. */
  text: string;
  tokenCount: number;
  pageFrom: number;
  pageTo: number;
  charStart: number;
  charEnd: number;
  sectionPath: string | null;
  /** The score this passage was ordered by: rerank score if any, else RRF. */
  score: number;
}

export interface RetrieveParams {
  userId: string;
  /** The conversation's document scope. Never empty. */
  documentIds: string[];
  /** The user's question, already rewritten if rewriting is enabled. */
  query: string;
  /** How many passages to assemble. Default `RETRIEVAL.k`. */
  k?: number;
  /** Per-call overrides for the ranking constants. See `RetrievalTuning`. */
  tuning?: RetrievalTuning;
  /** Test seam. Production passes nothing. */
  deps?: RetrievalDeps;
}

/**
 * THE SWEEPABLE KNOBS.
 *
 * Every constant in this module has a documented default and a reason for it,
 * and several of those reasons end in "that is worth measuring once the eval
 * harness exists". This is the seam that makes measuring possible: the eval
 * runner passes a different set of numbers per run and diffs the results,
 * without a second copy of `retrieve()` that could drift from the one the
 * product uses.
 *
 * PRODUCTION PASSES NOTHING. Every field is optional and every default comes
 * from the same `RETRIEVAL` / `RRF_K` / `ASSEMBLY` constants as before, so a
 * call site that ignores this object behaves exactly as it did. That is the
 * property that makes an eval number mean something: the thing being measured
 * is the thing that ships, with different arguments — not a parallel
 * implementation that happens to look similar.
 */
export interface RetrievalTuning {
  /** Candidates taken from EACH channel before fusion. Default 50. */
  channelDepth?: number;
  /** The RRF flattening constant. Default 60. Lower is more winner-take-all. */
  rrfK?: number;
  /** Weight on the dense channel in fusion. Default 1. Zero disables it. */
  denseWeight?: number;
  /** Weight on the lexical channel in fusion. Default 1. Zero disables it. */
  lexicalWeight?: number;
  /** Relative RRF floor, as a fraction of the top score. Default 0.3. */
  minRrfRatio?: number;
  /**
   * Absolute rerank floor when reranking ran. Defaults to the active
   * reranker's own `scoreFloor`, which differs per score scale — 0 for raw
   * logits, 0.02 for a probability. Set only to sweep it.
   */
  minRerankScore?: number;
  /** Hard cap on assembled passage tokens. Default 4,000. */
  maxContextTokens?: number;
  /** How many fused candidates the cross-encoder scores. Default `RERANK.candidates`. */
  rerankCandidates?: number;
}

export interface RetrievalResult {
  /** The query actually searched with, after any rewrite. */
  query: string;
  /** The context, in marker order. */
  passages: RetrievedPassage[];
  /** Every candidate either channel returned. THE TRACE. */
  candidates: RetrievalCandidate[];
  /** What happened, for the trace header and for logs. */
  stats: RetrievalStats;
}

export interface RetrievalStats {
  denseCount: number;
  lexicalCount: number;
  fusedCount: number;
  rerankedCount: number;
  /** Tokens of passage text handed to the model. */
  contextTokens: number;
  /** Null when reranking is off. */
  rerankModel: string | null;
  /**
   * True when the question contained no searchable terms at all — every word
   * was a stopword, or it was punctuation. Distinct from "no matches": the UI
   * should say "that question has no words to search for", not "these
   * documents don't mention it".
   */
  lexicalQueryEmpty: boolean;
  timings: {
    embedMs: number;
    denseMs: number;
    lexicalMs: number;
    rerankMs: number;
    totalMs: number;
  };
}

/**
 * A cross-encoder.
 *
 * Separate from `EmbeddingProvider` because it is a different KIND of model,
 * not a different implementation of the same one. A bi-encoder embeds the
 * query and the passage independently, which is what makes an index possible;
 * a cross-encoder reads the pair together in one forward pass, which is why it
 * is more accurate and why it can never be precomputed. That asymmetry is the
 * whole reason reranking is a second stage over a small candidate set rather
 * than a better first stage.
 */
export interface Reranker {
  readonly model: string;

  /**
   * The relevance boundary ON THIS RERANKER'S OWN SCALE.
   *
   * Part of the interface, not a constant in assemble.ts, because a floor is
   * only meaningful relative to the scale that produced it — and the two
   * implementations do not share one:
   *
   *   local        RAW LOGITS, unbounded, centred near 0. Floor 0, which is
   *                where the model was trained to separate relevant from
   *                irrelevant.
   *   openrouter   a PROBABILITY in (0, 1). Floor 0.02, measured.
   *
   * Getting this wrong is silent and total. A floor of 0 applied to a
   * probability admits every passage that can ever be scored, so the context is
   * never empty, and the system loses the one thing reranking gives it that RRF
   * structurally cannot: the ability to say "none of these are relevant".
   * Answers keep their citations and start resting on the least-bad passage.
   *
   * `RetrievalTuning.minRerankScore` still overrides this, so the eval harness
   * can sweep the floor. Absent an override, the reranker's own value is used.
   */
  readonly scoreFloor: number;

  /**
   * Score each passage against the query. Returns one score per passage, in
   * the order given. Higher is more relevant; the scale is the model's own and
   * is NOT comparable across models or to a cosine similarity.
   */
  score(query: string, passages: string[]): Promise<number[]>;
}

/**
 * Everything retrieval needs from the outside world, injectable.
 *
 * Production passes nothing. Tests pass a stub reranker, or a vector store
 * pointed at a throwaway collection, and get to exercise fusion and assembly
 * against real Postgres without a live model.
 */
export interface RetrievalDeps {
  embeddings?: import("@/lib/embeddings").EmbeddingProvider;
  vectors?: import("@/lib/vector").VectorStore;
  /** Explicit null forces reranking off even when the env enables it. */
  reranker?: Reranker | null;
}

/** Retrieval refused to run. The message is safe to show a user. */
export class RetrievalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RetrievalError";
  }
}
