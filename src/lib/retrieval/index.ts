import { and, eq, inArray, isNull } from "drizzle-orm";

import { db } from "@/db";
import { chunks, documents } from "@/db/schema";
import {
  EmbeddingError,
  EmbeddingSpaceError,
  assertSameEmbeddingSpace,
  getEmbeddingProvider,
} from "@/lib/embeddings";
import { getVectorStore } from "@/lib/vector";

import { ASSEMBLY, assemble } from "./assemble";
import { searchLexical } from "./lexical";
import { getReranker, RERANK } from "./rerank";
import { RRF_K, fuse } from "./rrf";
import {
  RetrievalError,
  type RetrievalCandidate,
  type RetrievalResult,
  type RetrieveParams,
} from "./types";

export type {
  Reranker,
  RetrievalCandidate,
  RetrievalChannel,
  RetrievalDeps,
  RetrievalResult,
  RetrievalStats,
  RetrievalTuning,
  RetrievedPassage,
  RetrieveParams,
} from "./types";
export { RetrievalError } from "./types";
export { RRF_K, fuse } from "./rrf";
export { ASSEMBLY, assemble } from "./assemble";
export { RERANK, createLocalReranker, getReranker } from "./rerank";
export { REWRITE, rewriteQuery, type ConversationTurn } from "./rewrite";
export { searchLexical } from "./lexical";

/**
 * HYBRID RETRIEVAL.
 *
 *   question
 *     → guard: one embedding space, one owner
 *     → dense  (Qdrant, filtered)      top 50 ┐
 *     → lexical (Postgres FTS)         top 50 ┤→ RRF (k=60)
 *     → rerank (optional, top 20)             ┘
 *     → assemble: floor, top k, merge, token cap
 *     → passages + trace
 *
 * The two channels run CONCURRENTLY. They share nothing — one is an HTTP call
 * to Qdrant, the other a query to Postgres — so running them in sequence would
 * add the smaller latency to the larger for no reason.
 *
 * Everything this returns is designed to be persisted: the passages become the
 * model's context and the citations that follow from it, and the candidates
 * become `retrievals` rows and the "Show retrieval" table under the answer.
 * The trace covers every candidate either channel returned, including the ones
 * that lost — those are the rows that explain a disappointing answer, and they
 * are the reason the trace is a feature rather than a log.
 */

export const RETRIEVAL = {
  /**
   * Candidates taken from each channel before fusion.
   *
   * Deep enough that a passage only one channel likes still has a chance —
   * which is the entire point of fusing, since the cases each channel handles
   * alone are exactly the ones the other ranks poorly or not at all. Both
   * channels are cheap at this depth: Qdrant is doing an indexed ANN search
   * and Postgres a GIN lookup, and neither cares much about 50 versus 10.
   *
   * The cost of depth is paid later, by reranking, which is why that has its
   * own much smaller window.
   */
  channelDepth: 50,

  /** Passages assembled into the context. */
  k: ASSEMBLY.k,
} as const;

/**
 * Retrieve passages for one question.
 *
 * `userId` is required and is applied at every layer — the embedding-space
 * guard, the vector payload filter, and the lexical join. Three checks of the
 * same fact, in three different systems, because a leak in any one of them is
 * a leak.
 */
export async function retrieve(
  params: RetrieveParams,
): Promise<RetrievalResult> {
  const { userId, documentIds, query, k = RETRIEVAL.k, deps } = params;
  const startedAt = Date.now();

  // Every ranking constant, resolved once. Production passes no `tuning` and
  // gets exactly the documented defaults; the eval runner passes a sweep.
  const tuning = params.tuning ?? {};
  const channelDepth = tuning.channelDepth ?? RETRIEVAL.channelDepth;
  const rrfK = tuning.rrfK ?? RRF_K;
  const denseWeight = tuning.denseWeight ?? 1;
  const lexicalWeight = tuning.lexicalWeight ?? 1;
  const rerankCandidates = tuning.rerankCandidates ?? RERANK.candidates;

  if (documentIds.length === 0) {
    throw new RetrievalError("No documents were selected for this search.");
  }
  if (query.trim().length === 0) {
    throw new RetrievalError("Enter a question to search these documents.");
  }

  // ── 1. GUARD ────────────────────────────────────────────────────────────
  // Before any work: are these documents comparable, and are they this user's?
  // Vectors from two embedding models are not comparable, and mixing them
  // degrades retrieval silently rather than failing — so it is refused loudly
  // here instead. This also proves ownership; see `assertSameEmbeddingSpace`.
  try {
    await assertSameEmbeddingSpace(documentIds, userId);
  } catch (error) {
    if (error instanceof EmbeddingSpaceError) {
      throw new RetrievalError(error.message, { cause: error });
    }
    throw error;
  }

  const embeddings = deps?.embeddings ?? getEmbeddingProvider();
  const vectors = deps?.vectors ?? getVectorStore();
  // `undefined` means "use the configured one"; explicit `null` forces off.
  const reranker = deps?.reranker === undefined ? getReranker() : deps.reranker;

  // ── 2 & 3. THE TWO CHANNELS, concurrently ───────────────────────────────
  const embedStartedAt = Date.now();
  /*
   * AN EMBEDDING FAILURE IS A RETRIEVAL FAILURE, AND IT MUST SAY SO.
   *
   * Without this wrapper an `EmbeddingError` propagates past `answer()` — which
   * re-throws anything that is not a `RetrievalError` — and out to the chat
   * route's `onError`, whose whole job is to mask stack-adjacent strings. The
   * result is that the ONE error in this system with a sentence written
   * specifically for a person ("the weights cache directory is not writable —
   * set TRANSFORMERS_CACHE_DIR", "the weights could not be downloaded") is the
   * one error nobody ever sees. It arrives as "That answer could not be
   * completed. Try asking again."
   *
   * That is not a hypothetical: it is how the first production deployment
   * presented a completely broken local-inference stack — a generic retry
   * message, on a failure no amount of retrying would clear.
   *
   * The message is safe to show. `describeLoadFailure` in
   * src/lib/embeddings/local.ts turns the two operational causes into
   * instructions and passes anything else through as the model host's own text;
   * none of it is a stack trace and none of it names a secret.
   */
  let queryVector: number[];
  try {
    queryVector = await embeddings.embedQuery(query);
  } catch (error) {
    if (error instanceof EmbeddingError) {
      throw new RetrievalError(
        `The search index could not be reached. ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
  const embedMs = Date.now() - embedStartedAt;

  const denseStartedAt = Date.now();
  const densePromise = vectors
    .search({
      userId,
      documentIds,
      vector: queryVector,
      limit: channelDepth,
    })
    .then((hits) => ({ hits, ms: Date.now() - denseStartedAt }));

  const lexicalStartedAt = Date.now();
  const lexicalPromise = searchLexical({
    userId,
    documentIds,
    query,
    limit: channelDepth,
  }).then((result) => ({ result, ms: Date.now() - lexicalStartedAt }));

  const [dense, lexical] = await Promise.all([densePromise, lexicalPromise]);

  // ── 4. FUSE ─────────────────────────────────────────────────────────────
  const denseIds = dense.hits.map((hit) => hit.chunkId);
  const lexicalIds = lexical.result.hits.map((hit) => hit.chunkId);
  const fused = fuse(
    [
      { ids: denseIds, weight: denseWeight },
      { ids: lexicalIds, weight: lexicalWeight },
    ],
    rrfK,
  );

  if (fused.length === 0) {
    return emptyResult(query, {
      denseMs: dense.ms,
      lexicalMs: lexical.ms,
      embedMs,
      startedAt,
      lexicalQueryEmpty: lexical.result.queryEmpty,
    });
  }

  // Hydrate. The vector store holds only ids and page numbers — the text lives
  // in Postgres, which is also where the ownership predicate can be reasserted
  // one last time before any of it is shown to anyone.
  const rows = await hydrate(
    userId,
    documentIds,
    fused.map((entry) => entry.id),
  );

  const denseScores = new Map(dense.hits.map((hit) => [hit.chunkId, hit.score]));
  const lexicalScores = new Map(
    lexical.result.hits.map((hit) => [hit.chunkId, hit.score]),
  );

  const candidates: RetrievalCandidate[] = [];
  for (const entry of fused) {
    const row = rows.get(entry.id);
    // A chunk in the vector store with no row behind it: re-ingested or
    // deleted between the search and now. Dropped rather than surfaced —
    // there is no text to show and no citation to resolve.
    if (!row) continue;

    const [denseRank, lexicalRank] = entry.ranks;
    candidates.push({
      ...row,
      denseRank,
      denseScore: denseRank === null ? null : (denseScores.get(entry.id) ?? null),
      lexicalRank,
      lexicalScore:
        lexicalRank === null ? null : (lexicalScores.get(entry.id) ?? null),
      rrfScore: entry.score,
      channel:
        denseRank !== null && lexicalRank !== null
          ? "both"
          : denseRank !== null
            ? "dense"
            : "lexical",
      rerankScore: null,
      used: false,
    });
  }

  // ── 5. RERANK (optional; off by default) ────────────────────────────────
  let rerankMs = 0;
  let rerankedCount = 0;

  if (reranker && candidates.length > 0) {
    const rerankStartedAt = Date.now();
    const window = candidates.slice(0, rerankCandidates);

    try {
      const scores = await reranker.score(
        query,
        window.map((candidate) => candidate.text),
      );
      window.forEach((candidate, index) => {
        candidate.rerankScore = scores[index] ?? null;
      });
      rerankedCount = window.length;

      // Reranked candidates sort above un-reranked ones regardless of score,
      // because the two scales are unrelated — a cross-encoder logit and an RRF
      // score cannot be compared, and a passage outside the window was ranked
      // below every passage inside it to begin with.
      candidates.sort((a, b) => {
        const aScored = a.rerankScore !== null;
        const bScored = b.rerankScore !== null;
        if (aScored !== bScored) return aScored ? -1 : 1;
        if (aScored && bScored) return b.rerankScore! - a.rerankScore!;
        return b.rrfScore - a.rrfScore;
      });
    } catch (error) {
      // Reranking is an improvement, not a requirement. Losing it costs
      // ordering quality; failing the query costs the answer.
      console.warn("[retrieval] reranking failed; falling back to RRF", error);
      for (const candidate of candidates) candidate.rerankScore = null;
      rerankedCount = 0;
    }

    rerankMs = Date.now() - rerankStartedAt;
  }

  // ── 6. ASSEMBLE ─────────────────────────────────────────────────────────
  // Mutates `used` on the candidates it keeps, so the trace and the context
  // cannot disagree about what the model was shown.
  const { passages, contextTokens } = assemble(candidates, {
    k,
    reranked: rerankedCount > 0,
    minRrfRatio: tuning.minRrfRatio,
    /*
     * The floor defaults to THE RERANKER'S OWN, not to a module constant.
     *
     * The two implementations score on different scales — raw logits centred
     * on zero, and a probability in (0, 1) — so one shared default is correct
     * for at most one of them. Applying the logit floor of 0 to a probability
     * would admit every passage ever scored and quietly delete the relevance
     * floor. An explicit `tuning.minRerankScore` still wins, so the eval
     * harness can sweep it.
     */
    minRerankScore: tuning.minRerankScore ?? reranker?.scoreFloor,
    maxContextTokens: tuning.maxContextTokens,
  });

  // ── 7. RETURN, with the trace ───────────────────────────────────────────
  return {
    query,
    passages,
    candidates,
    stats: {
      denseCount: dense.hits.length,
      lexicalCount: lexical.result.hits.length,
      fusedCount: candidates.length,
      rerankedCount,
      contextTokens,
      rerankModel: rerankedCount > 0 ? (reranker?.model ?? null) : null,
      lexicalQueryEmpty: lexical.result.queryEmpty,
      timings: {
        embedMs,
        denseMs: dense.ms,
        lexicalMs: lexical.ms,
        rerankMs,
        totalMs: Date.now() - startedAt,
      },
    },
  };
}

/**
 * Load the chunk rows behind a set of ids.
 *
 * The ownership predicate is applied AGAIN here, even though the ids came from
 * two already-filtered channels. This is the last point before text is
 * returned to a caller, and it is a cheap join on an indexed column — the one
 * place where being redundant costs nothing and being wrong costs everything.
 */
async function hydrate(
  userId: string,
  documentIds: string[],
  chunkIds: string[],
): Promise<Map<string, Omit<RetrievalCandidate,
  | "denseRank" | "denseScore" | "lexicalRank" | "lexicalScore"
  | "rrfScore" | "channel" | "rerankScore" | "used">>> {
  if (chunkIds.length === 0) return new Map();

  const rows = await db
    .select({
      chunkId: chunks.id,
      documentId: chunks.documentId,
      documentTitle: documents.title,
      ordinal: chunks.ordinal,
      text: chunks.text,
      tokenCount: chunks.tokenCount,
      pageFrom: chunks.pageFrom,
      pageTo: chunks.pageTo,
      charStart: chunks.charStart,
      charEnd: chunks.charEnd,
      sectionPath: chunks.sectionPath,
    })
    .from(chunks)
    .innerJoin(documents, eq(documents.id, chunks.documentId))
    .where(
      and(
        inArray(chunks.id, chunkIds),
        inArray(chunks.documentId, documentIds),
        eq(documents.userId, userId),
        isNull(documents.deletedAt),
      ),
    );

  return new Map(rows.map((row) => [row.chunkId, row]));
}

function emptyResult(
  query: string,
  timing: {
    embedMs: number;
    denseMs: number;
    lexicalMs: number;
    startedAt: number;
    lexicalQueryEmpty: boolean;
  },
): RetrievalResult {
  return {
    query,
    passages: [],
    candidates: [],
    stats: {
      denseCount: 0,
      lexicalCount: 0,
      fusedCount: 0,
      rerankedCount: 0,
      contextTokens: 0,
      rerankModel: null,
      lexicalQueryEmpty: timing.lexicalQueryEmpty,
      timings: {
        embedMs: timing.embedMs,
        denseMs: timing.denseMs,
        lexicalMs: timing.lexicalMs,
        rerankMs: 0,
        totalMs: Date.now() - timing.startedAt,
      },
    },
  };
}
