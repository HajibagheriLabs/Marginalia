import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import { chunks, documents } from "@/db/schema";
import { getEmbeddingProvider } from "@/lib/embeddings";
import { getVectorStore } from "@/lib/vector";

import { StageError, type StageDeps, type StageResult } from "./stage";

/**
 * STAGE 4: INDEXING.
 *
 *   uploaded → extracting → chunking → embedding → INDEXING → ready | failed
 *
 * The gate between "we think this document is indexed" and "this document is
 * searchable". It writes no vectors — the embedding stage already did, for the
 * reason given in its header — and instead checks that what the pipeline
 * believes happened actually happened, then flips the document live.
 *
 * WHY A SEPARATE STAGE FOR A CHECK. The alternative is for the embedding stage
 * to declare the document ready when its last batch succeeds, which trusts a
 * sequence of a few hundred network writes to have all landed because none of
 * them threw. That trust is misplaced in exactly the case that matters: an
 * upsert that returns 200 for a batch the store later drops, a collection
 * recreated underneath a running job, points written to the wrong collection
 * after a config change. Every one of those produces a document that looks
 * ready, answers questions, and quietly omits passages — and a missing passage
 * is invisible, because the model simply answers from what it was given.
 *
 * So the count is verified against the store before anything is called ready.
 * Cheap — one request — and it converts a silent gap into a failed document
 * with a retry button.
 *
 * IDEMPOTENCE: re-running re-checks and re-writes the same three fields with
 * the same values. There is nothing to duplicate because there is nothing
 * inserted.
 */
export async function runIndexing(
  documentId: string,
  userId: string,
  deps?: StageDeps,
): Promise<StageResult> {
  const store = deps?.vectors ?? getVectorStore();
  const provider = deps?.embeddings ?? getEmbeddingProvider();

  const [document] = await db
    .select({
      id: documents.id,
      chunkCount: documents.chunkCount,
      embeddingModel: documents.embeddingModel,
      embeddingDim: documents.embeddingDim,
    })
    .from(documents)
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.userId, userId),
        isNull(documents.deletedAt),
      ),
    )
    .limit(1);

  if (!document) throw new StageError("That document no longer exists.");

  const [counts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      indexed: sql<number>`count(${chunks.indexedAt})::int`,
    })
    .from(chunks)
    .where(eq(chunks.documentId, document.id));

  if (counts.total === 0) {
    throw new StageError(
      "This document has no passages to index. Retry from the beginning.",
    );
  }

  if (counts.indexed !== counts.total) {
    // The orchestrator should not have advanced past embedding. Send it back
    // rather than declaring a partially indexed document ready.
    throw new StageError(
      `Only ${counts.indexed} of ${counts.total} passages were indexed. Retry to finish indexing.`,
    );
  }

  // THE VERIFICATION. Ask the store what it actually holds for this document,
  // through the same filtered search path every query uses — so this also
  // proves the payload filter matches the points that were written, not just
  // that some points exist.
  let stored: number;
  try {
    const hits = await store.search({
      userId,
      documentIds: [document.id],
      // A zero vector is a legitimate query here: nothing is being ranked. The
      // limit is what makes this a count, and cosine against a zero vector is
      // undefined-but-harmless when every candidate is already filtered to this
      // one document.
      vector: new Array<number>(provider.dimensions).fill(0),
      limit: counts.total + 1,
    });
    stored = hits.length;
  } catch (error) {
    throw new StageError(
      "The search index could not be verified. Try again in a moment.",
      { cause: error },
    );
  }

  // EXACT equality, in both directions. Too few means upserts were lost. Too
  // many means stale points from an earlier chunking of this document survived
  // — passages that resolve to chunk ids no longer in the database, which are
  // dropped silently on the way out of retrieval and quietly shrink every
  // result set. Neither is a document that should be called ready.
  if (stored !== counts.total) {
    throw new StageError(
      `The search index holds ${stored} entries for this document's ${counts.total} passages. Retry to rebuild it.`,
    );
  }

  await db
    .update(documents)
    .set({
      chunkCount: counts.total,
      embeddingModel: provider.model,
      embeddingDim: provider.dimensions,
      readyAt: new Date(),
    })
    .where(eq(documents.id, document.id));

  return { complete: true, detail: `${stored} passages verified in the index` };
}
