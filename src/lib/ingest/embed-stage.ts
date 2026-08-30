import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import { chunks, documents, usageEvents } from "@/db/schema";
import {
  LOCAL_EMBEDDING,
  getEmbeddingProvider,
  type EmbeddingProvider,
} from "@/lib/embeddings";
import { getVectorStore, type VectorPoint, type VectorStore } from "@/lib/vector";

import { countTokens, embeddingText } from "./chunk";
import { StageError, deadlineFrom, type StageDeps, type StageResult } from "./stage";

/**
 * STAGE 3: EMBEDDING.
 *
 *   uploaded → extracting → chunking → EMBEDDING → indexing → ready | failed
 *
 * The only stage that can run out of time before it runs out of work, and the
 * only one that talks to both the model and the vector store. Everything about
 * its shape follows from those two facts.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THE VECTOR WRITE HAPPENS HERE AND NOT IN "INDEXING"
 *
 * The obvious split — embed here, upsert there — would need somewhere to keep
 * 600 x 384 floats between two function invocations. The only places to put
 * them are memory, which does not survive the gap, or Postgres, which would
 * mean storing every vector twice and contradicts the rule that Qdrant holds
 * the embeddings. So a vector is upserted in the same batch that produced it,
 * and it is never held anywhere else.
 *
 * That leaves `indexing` as a verification and activation gate rather than a
 * write, which is what it should be anyway: something has to check that what
 * Qdrant actually holds matches what this stage believes it wrote, before a
 * document is declared searchable. See `index-stage.ts`.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * RESUMABILITY AND IDEMPOTENCE, from one column
 *
 * `chunks.indexed_at` is the entire mechanism. The working query is "this
 * document's chunks where indexed_at is null, in order", so:
 *
 *   - a re-run after a crash at passage 400 of 612 starts at 400;
 *   - a re-run of a COMPLETED stage selects zero rows and writes nothing;
 *   - progress is `count(indexed_at is not null)`, derived from the work
 *     rather than from a counter that could disagree with it.
 *
 * The mark is written AFTER the upsert is acknowledged, never before. The
 * failure that ordering prevents: marking first, then failing to upsert, would
 * leave a chunk that every future run skips and that no search can ever return
 * — a passage silently missing from the index with nothing to indicate it.
 * Marking after can at worst re-embed a batch that was already stored, and the
 * upsert is keyed by chunk id, so doing it twice changes nothing.
 */

/**
 * How long a single invocation spends embedding before handing control back.
 *
 * Well inside the ~300 s a Vercel function gets with Fluid Compute on, with
 * room for the model load on a cold instance (which can be 30 s the first time
 * an instance touches the weights) plus the orchestrator's own overhead. The
 * orchestrator passes its own deadline in production; this is the floor for a
 * direct call.
 */
export const EMBED_STAGE_BUDGET_MS = 120_000;

/** Load the document and prove ownership in the same query. */
async function loadDocument(documentId: string, userId: string) {
  const [document] = await db
    .select({
      id: documents.id,
      userId: documents.userId,
      title: documents.title,
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
  return document;
}

/**
 * If the embedding model changed under a partly-indexed document, start over.
 *
 * Vectors from two models are not comparable, so a document holding some of
 * each is worse than one holding none: it would return results ranked by a
 * similarity that means nothing for half its passages, silently. Resetting is
 * the only correct response, and doing it here — rather than refusing at search
 * time — means the document repairs itself instead of becoming permanently
 * unsearchable.
 */
async function resetIfSpaceChanged(
  document: { id: string; embeddingModel: string | null; embeddingDim: number | null },
  provider: EmbeddingProvider,
  store: VectorStore,
): Promise<boolean> {
  const changed =
    document.embeddingModel !== null &&
    (document.embeddingModel !== provider.model ||
      document.embeddingDim !== provider.dimensions);

  if (!changed) return false;

  console.warn(
    `[embed] ${document.id} was indexed with ${document.embeddingModel} ` +
      `(${document.embeddingDim}d) but the active model is ${provider.model} ` +
      `(${provider.dimensions}d). Discarding its vectors and re-embedding.`,
  );

  await store.deleteByDocument(document.id);
  await db
    .update(chunks)
    .set({ indexedAt: null, embeddingModel: null })
    .where(eq(chunks.documentId, document.id));

  return true;
}

export async function runEmbedding(
  documentId: string,
  userId: string,
  deps?: StageDeps,
): Promise<StageResult> {
  const provider = deps?.embeddings ?? getEmbeddingProvider();
  const store = deps?.vectors ?? getVectorStore();
  const deadline = deadlineFrom(deps, EMBED_STAGE_BUDGET_MS);

  const document = await loadDocument(documentId, userId);
  await resetIfSpaceChanged(document, provider, store);

  // Stamp the space before writing any vector, so a document that fails halfway
  // still records which model produced the vectors it does have.
  await db
    .update(documents)
    .set({
      embeddingModel: provider.model,
      embeddingDim: provider.dimensions,
    })
    .where(eq(documents.id, document.id));

  const pending = await db
    .select({
      id: chunks.id,
      text: chunks.text,
      sectionPath: chunks.sectionPath,
      pageFrom: chunks.pageFrom,
      pageTo: chunks.pageTo,
    })
    .from(chunks)
    .where(and(eq(chunks.documentId, document.id), isNull(chunks.indexedAt)))
    .orderBy(asc(chunks.ordinal));

  if (pending.length === 0) {
    // Either the stage already finished, or chunking produced nothing. The
    // latter is a real failure and chunking would have caught it, so reaching
    // here with zero chunks at all means the row advanced without its chunks.
    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(chunks)
      .where(eq(chunks.documentId, document.id));

    if (total === 0) {
      throw new StageError(
        "This document has no passages to embed. Retry from the beginning.",
      );
    }
    return { complete: true, detail: "already embedded" };
  }

  // The collection has to exist before the first upsert. Idempotent, and only
  // paid for when there is actually work to do.
  await store.ensureCollection();

  const startedAt = Date.now();
  let embedded = 0;
  let tokens = 0;

  for (let i = 0; i < pending.length; i += LOCAL_EMBEDDING.batchSize) {
    // Checked BEFORE taking a batch, never during one. A batch that has been
    // started is always finished and always recorded — abandoning work in
    // flight is exactly the half-written state idempotence exists to avoid.
    // The `i > 0` guard guarantees forward progress: an invocation that starts
    // already past its deadline still does one batch, so a too-tight budget
    // makes ingestion slow rather than making it loop forever.
    if (i > 0 && Date.now() >= deadline) break;

    const batch = pending.slice(i, i + LOCAL_EMBEDDING.batchSize);

    // THE AUGMENTED TEXT — title and section breadcrumb prepended. This is what
    // gets embedded; `chunk.text` stays the document's own words. See
    // `embeddingText` for why this is the cheapest retrieval win available.
    const augmented = batch.map((chunk) =>
      embeddingText(
        { text: chunk.text, sectionPath: chunk.sectionPath },
        document.title,
      ),
    );

    let vectors: number[][];
    try {
      vectors = await provider.embedDocuments(augmented);
    } catch (error) {
      throw new StageError(
        "The passages in this document could not be embedded. Try again in a moment.",
        { cause: error },
      );
    }

    const points: VectorPoint[] = batch.map((chunk, index) => ({
      // The chunk's own id. Re-running the stage overwrites the same point
      // rather than adding a second copy of the same passage.
      id: chunk.id,
      vector: vectors[index],
      payload: {
        user_id: userId,
        document_id: document.id,
        chunk_id: chunk.id,
        page_from: chunk.pageFrom,
        page_to: chunk.pageTo,
      },
    }));

    try {
      await store.upsert(points);
    } catch (error) {
      throw new StageError(
        "The search index could not be updated. Try again in a moment.",
        { cause: error },
      );
    }

    // Only now. See the header: marking before the upsert is acknowledged
    // would strand passages that no future run looks at again.
    const now = new Date();
    await db
      .update(chunks)
      .set({ indexedAt: now, embeddingModel: provider.model })
      .where(
        inArray(
          chunks.id,
          batch.map((chunk) => chunk.id),
        ),
      );

    embedded += batch.length;
    tokens += augmented.reduce((sum, text) => sum + countTokens(text), 0);
  }

  const elapsed = Date.now() - startedAt;

  if (embedded > 0) {
    await recordEmbeddingUsage(userId, tokens, elapsed);
  }

  const complete = embedded === pending.length;
  return {
    complete,
    detail: `${embedded}/${pending.length} passages, ${tokens} tokens, ${elapsed}ms${
      complete ? "" : " (resuming)"
    }`,
  };
}

/**
 * Meter the work, honestly.
 *
 * `cost_cents` is 0 and that is a FACT, not a placeholder: the model runs in
 * this process on this server's CPU, so there is no per-token price to record
 * and inventing one — a notional OpenAI rate, say — would put a fabricated
 * number in front of the user on the settings page.
 *
 * What is real is the token count and the wall-clock time, so those are what
 * get stored, with `source: "local"` to say why the price column is empty. The
 * settings page can then say "1.2M tokens embedded locally, 4m 12s of compute,
 * no API cost" instead of showing a zero that looks like missing data.
 */
async function recordEmbeddingUsage(
  userId: string,
  tokens: number,
  durationMs: number,
): Promise<void> {
  try {
    await db.insert(usageEvents).values({
      userId,
      kind: "embedding",
      quantity: tokens,
      costCents: 0,
      source: "local",
      durationMs,
    });
  } catch (error) {
    // Metering is bookkeeping. Losing a usage row must never fail an ingestion
    // that otherwise succeeded, or turn a retry into a loop.
    console.error("[embed] failed to record usage", error);
  }
}
