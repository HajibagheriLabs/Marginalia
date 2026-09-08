import { randomUUID } from "node:crypto";

import { QdrantClient } from "@qdrant/js-client-rest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { db } from "@/db";
import {
  chunks,
  documentPages,
  documents,
  usageEvents,
  users,
} from "@/db/schema";
import {
  LOCAL_EMBEDDING,
  getEmbeddingProvider,
  type EmbeddingProvider,
} from "@/lib/embeddings";
import { createQdrantVectorStore, type VectorStore } from "@/lib/vector";
import { describeIntegration } from "@/test/harness";

import { assemblePages } from "./extract";
import { runPipeline } from "./pipeline";

/**
 * THE PIPELINE, END TO END, AGAINST REAL INFRASTRUCTURE.
 *
 * Real Postgres, real Qdrant, the real embedding model. The properties under
 * test are all properties of how those three behave together under failure and
 * repetition, and every one of them would be asserted away by a mock:
 *
 *   - a document that fails mid-embedding RESUMES rather than restarting;
 *   - after the retry the store holds EXACTLY ONE point per passage, not two;
 *   - re-running a completed stage changes nothing at all.
 *
 * The last one is the reason the whole design works. Every recovery path in
 * this pipeline — the retry button, a re-delivered queue message, an
 * orchestrator that runs one stage twice because an invocation was replayed —
 * is safe only because stages are idempotent. That is an easy claim to make and
 * a hard one to keep, so it is measured rather than asserted in a comment.
 *
 * The pipeline is driven from `chunking` rather than from `uploaded`: starting
 * at `uploaded` would run extraction, which needs a real file in Vercel Blob.
 * The pages are inserted directly instead, by the same `assemblePages` that
 * extraction uses, so the offsets are produced by production code.
 */


/**
 * A document long enough to need SEVERAL embedding batches.
 *
 * The size is load-bearing, not arbitrary. Passages are packed to ~300 tokens
 * and the provider embeds 32 at a time, so a document must exceed 32 passages
 * before "fail on the second batch" is even expressible. An earlier version of
 * this fixture produced nine passages — one batch — and the failure-injection
 * test ran green while testing nothing: the injected outage was never reached.
 * The precondition is asserted below so that can never happen quietly again.
 */
function buildPages(): string[] {
  const clause = (n: number) =>
    `${n}. The Provider shall deliver the services described in Schedule ${n} ` +
    `with reasonable skill and care, and shall notify the Customer in writing ` +
    `of any delay affecting the agreed delivery date for milestone ${n}.`;

  return Array.from({ length: 12 }, (_, page) =>
    Array.from({ length: 40 }, (_, i) => clause(page * 40 + i + 1)).join("\n\n"),
  );
}

/**
 * An embedding provider that fails after N successful batches.
 *
 * Wraps the real provider rather than returning fake vectors, so the passages
 * that DID get embedded before the failure are genuine — which is what makes
 * "resume from 32 of 72" a real resume rather than a bookkeeping exercise.
 */
function failingAfter(
  real: EmbeddingProvider,
  batches: number,
): EmbeddingProvider {
  let seen = 0;
  return {
    model: real.model,
    dimensions: real.dimensions,
    async embedDocuments(texts) {
      if (seen >= batches) {
        throw new Error("simulated embedding provider outage");
      }
      seen += 1;
      return real.embedDocuments(texts);
    },
    embedQuery: (text) => real.embedQuery(text),
  };
}

describeIntegration("P3 — ingestion idempotency: the four-stage pipeline", { postgres: true, qdrant: true, models: true }, () => {
  const collection = `marginalia_pipeline_test_${Date.now()}_${randomUUID().slice(0, 8)}`;

  let raw: QdrantClient;
  let store: VectorStore;
  let provider: EmbeddingProvider;

  let userId: string;
  let documentId: string;
  let pageCount: number;

  /** Points Qdrant actually holds for the document under test. */
  async function storedPointCount(): Promise<number> {
    const result = await raw.count(collection, {
      filter: { must: [{ key: "document_id", match: { value: documentId } }] },
      exact: true,
    });
    return result.count;
  }

  async function readDocument() {
    const [row] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    return row;
  }

  async function chunkCounts() {
    const [row] = await db
      .select({
        total: sql<number>`count(*)::int`,
        indexed: sql<number>`count(${chunks.indexedAt})::int`,
      })
      .from(chunks)
      .where(eq(chunks.documentId, documentId));
    return row;
  }

  beforeAll(async () => {
    raw = new QdrantClient({
      url: process.env.QDRANT_URL!,
      apiKey: process.env.QDRANT_API_KEY!,
      timeout: 30_000,
      checkCompatibility: false,
    });
    store = createQdrantVectorStore(collection);
    provider = getEmbeddingProvider();

    // Warm the model here so a cold download does not eat a test's budget.
    await provider.embedQuery("warm up");

    const [user] = await db
      .insert(users)
      .values({
        name: "Pipeline Test",
        email: `pipeline-test-${randomUUID()}@example.test`,
        emailVerified: true,
      })
      .returning({ id: users.id });
    userId = user.id;
  }, 300_000);

  afterAll(async () => {
    // Deleting the user cascades to documents, pages, chunks, and usage rows.
    if (userId) await db.delete(users).where(eq(users.id, userId));
    if (raw) await raw.deleteCollection(collection).catch(() => undefined);
  });

  /** A fresh document, extracted but not yet chunked, before every test. */
  beforeEach(async () => {
    const { pages } = assemblePages(buildPages());
    pageCount = pages.length;

    const [created] = await db
      .insert(documents)
      .values({
        userId,
        title: "Pipeline Test Agreement",
        filename: "pipeline-test.md",
        mimeType: "text/markdown",
        byteSize: 4096,
        blobUrl: "https://example.test/pipeline-test.md",
        blobPathname: `${userId}/pipeline-test.md`,
        pageCount,
        // Extraction has already run; the pipeline starts at chunking.
        status: "chunking",
      })
      .returning({ id: documents.id });
    documentId = created.id;

    await db.insert(documentPages).values(
      pages.map((page) => ({
        documentId,
        pageNumber: page.pageNumber,
        text: page.text,
        charStart: page.charStart,
        charEnd: page.charEnd,
      })),
    );
  });

  it("runs chunking, embedding, and indexing through to ready", async () => {
    const outcome = await runPipeline(documentId, userId, {
      embeddings: provider,
      vectors: store,
    });

    expect(outcome.status).toBe("ready");
    expect(outcome.finished).toBe(true);
    expect(outcome.ran).toEqual(["chunking", "embedding", "indexing"]);

    const document = await readDocument();
    expect(document.status).toBe("ready");
    expect(document.failedStage).toBeNull();
    expect(document.errorMessage).toBeNull();
    expect(document.readyAt).not.toBeNull();
    expect(document.embeddingModel).toBe(provider.model);
    expect(document.embeddingDim).toBe(provider.dimensions);

    const counts = await chunkCounts();
    expect(counts.total).toBeGreaterThan(0);
    expect(counts.indexed).toBe(counts.total);
    expect(document.chunkCount).toBe(counts.total);

    // One point per passage. Not two.
    expect(await storedPointCount()).toBe(counts.total);
  }, 300_000);

  it("records embedding usage as local work with no invented price", async () => {
    await runPipeline(documentId, userId, {
      embeddings: provider,
      vectors: store,
    });

    const rows = await db
      .select()
      .from(usageEvents)
      .where(and(eq(usageEvents.userId, userId), eq(usageEvents.kind, "embedding")));

    expect(rows.length).toBeGreaterThan(0);
    const row = rows[rows.length - 1];

    expect(row.quantity).toBeGreaterThan(0);
    expect(row.durationMs).toBeGreaterThan(0);
    // Zero because it IS zero — the model ran on this machine.
    expect(row.costCents).toBe(0);
    expect(row.source).toBe("local");
  }, 300_000);

  /* ====================================================================== *
   * THE FAILURE AND RETRY PATH
   * ====================================================================== */

  it("fails at embedding, resumes from there, and ends with exactly one set of points", async () => {
    // Fail on the SECOND batch, so the first 32 passages are genuinely
    // embedded and stored, and the rest genuinely are not.
    const flaky = failingAfter(provider, 1);

    const failed = await runPipeline(documentId, userId, {
      embeddings: flaky,
      vectors: store,
    });

    // THE PRECONDITION, checked before anything else. If the fixture ever packs
    // into a single batch again, the injected outage is never reached and every
    // assertion below passes while testing nothing. Fail on this line, which
    // says why, rather than on a confusing "expected ready to be failed".
    const sized = await chunkCounts();
    expect(sized.total).toBeGreaterThan(LOCAL_EMBEDDING.batchSize);

    expect(failed.status).toBe("failed");

    const broken = await readDocument();
    expect(broken.status).toBe("failed");
    // WHERE it died, so the retry knows where to resume.
    expect(broken.failedStage).toBe("embedding");
    expect(broken.errorMessage).toBeTruthy();
    // The message is the stage's own words, never the raw provider error.
    expect(broken.errorMessage).not.toContain("simulated");

    // Chunking's work SURVIVED the failure. This is what makes the retry a
    // resume: nothing before the failing stage is thrown away.
    const afterFailure = await chunkCounts();
    expect(afterFailure.total).toBeGreaterThan(0);
    expect(afterFailure.indexed).toBeGreaterThan(0);
    expect(afterFailure.indexed).toBeLessThan(afterFailure.total);

    const partialPoints = await storedPointCount();
    expect(partialPoints).toBe(afterFailure.indexed);

    // ---- THE RETRY, exactly as the action performs it -------------------
    await db
      .update(documents)
      .set({
        status: broken.failedStage!,
        failedStage: null,
        errorMessage: null,
      })
      .where(and(eq(documents.id, documentId), isNull(documents.deletedAt)));

    const retried = await runPipeline(documentId, userId, {
      embeddings: provider,
      vectors: store,
    });

    expect(retried.status).toBe("ready");
    // It resumed: chunking did NOT run a second time.
    expect(retried.ran).toEqual(["embedding", "indexing"]);

    const healed = await readDocument();
    expect(healed.status).toBe("ready");
    expect(healed.failedStage).toBeNull();
    expect(healed.errorMessage).toBeNull();

    const finalCounts = await chunkCounts();
    expect(finalCounts.indexed).toBe(finalCounts.total);
    expect(finalCounts.total).toBe(afterFailure.total);

    // THE ASSERTION THE WHOLE TEST EXISTS FOR. The passages embedded before the
    // failure were upserted by chunk id, so the retry overwrote them rather
    // than adding a second copy. Anything other than exact equality here means
    // duplicate vectors — the same passage retrievable twice, occupying two
    // slots in a top-k that only has eight.
    expect(await storedPointCount()).toBe(finalCounts.total);
  }, 300_000);

  /* ====================================================================== *
   * IDEMPOTENCE
   * ====================================================================== */

  it("changes nothing when a completed pipeline is run again", async () => {
    await runPipeline(documentId, userId, {
      embeddings: provider,
      vectors: store,
    });

    const before = await readDocument();
    const beforeCounts = await chunkCounts();
    const beforePoints = await storedPointCount();
    const beforeChunkIds = (
      await db
        .select({ id: chunks.id })
        .from(chunks)
        .where(eq(chunks.documentId, documentId))
    )
      .map((row) => row.id)
      .sort();

    const again = await runPipeline(documentId, userId, {
      embeddings: provider,
      vectors: store,
    });

    // Already terminal: the orchestrator returns without running a stage.
    expect(again.status).toBe("ready");
    expect(again.ran).toEqual([]);

    const after = await readDocument();
    const afterCounts = await chunkCounts();
    const afterChunkIds = (
      await db
        .select({ id: chunks.id })
        .from(chunks)
        .where(eq(chunks.documentId, documentId))
    )
      .map((row) => row.id)
      .sort();

    expect(afterCounts).toEqual(beforeCounts);
    expect(await storedPointCount()).toBe(beforePoints);
    // Same rows, not merely the same count — a delete-and-reinsert would keep
    // the count identical while invalidating every chunk id a citation points
    // at.
    expect(afterChunkIds).toEqual(beforeChunkIds);
    expect(after.readyAt?.getTime()).toBe(before.readyAt?.getTime());
  }, 300_000);

  it("re-runs a single completed stage without duplicating its output", async () => {
    await runPipeline(documentId, userId, {
      embeddings: provider,
      vectors: store,
    });

    const beforeCounts = await chunkCounts();
    const beforePoints = await storedPointCount();

    // Force the document back to embedding — the situation a redelivered queue
    // message or a replayed invocation produces.
    await db
      .update(documents)
      .set({ status: "embedding" })
      .where(eq(documents.id, documentId));

    const replayed = await runPipeline(documentId, userId, {
      embeddings: provider,
      vectors: store,
    });

    expect(replayed.status).toBe("ready");

    // The stage found nothing to do, because every chunk was already marked
    // indexed. No re-embedding, and above all no second set of points.
    expect(await chunkCounts()).toEqual(beforeCounts);
    expect(await storedPointCount()).toBe(beforePoints);
  }, 300_000);

  it("re-chunking discards the old passages instead of appending", async () => {
    await runPipeline(documentId, userId, {
      embeddings: provider,
      vectors: store,
    });
    const first = await chunkCounts();

    // Back to chunking: the stage deletes and rewrites this document's chunks.
    await db
      .update(documents)
      .set({ status: "chunking" })
      .where(eq(documents.id, documentId));

    await runPipeline(documentId, userId, {
      embeddings: provider,
      vectors: store,
    });

    const second = await chunkCounts();
    // Same document, same text, same budget: the same number of passages, not
    // double.
    expect(second.total).toBe(first.total);
    expect(second.indexed).toBe(second.total);
    expect(await storedPointCount()).toBe(second.total);
  }, 300_000);

  /**
   * DELETING A DOCUMENT MUST TAKE ITS VECTORS WITH IT.
   *
   * The rows are the easy half — a foreign key handles chunks and pages. The
   * vectors are the half that leaks, because Qdrant knows nothing about the
   * delete and nothing in Postgres references a point id. Orphaned points are
   * invisible: the document vanishes from the library, every list query is
   * correct, and the passages stay in the collection indefinitely, still
   * carrying the user's text and still matching their queries.
   *
   * This exercises the same sequence `deleteDocument` performs — vectors first,
   * then rows — rather than calling the Server Action, which would need a
   * session. What is asserted is the property that matters and the one a
   * refactor can silently drop: after a delete, the store holds NOTHING for
   * that document.
   */
  it("removes the document's vectors when the document is deleted", async () => {
    await runPipeline(documentId, userId, {
      embeddings: provider,
      vectors: store,
    });

    // The precondition. Without it a broken pipeline would make the assertion
    // below pass by having written no points in the first place.
    const before = await storedPointCount();
    expect(before).toBeGreaterThan(0);

    // Step 2 of deleteDocument: the vectors, which nothing else can reach.
    await store.deleteByDocument(documentId);

    // Step 3: the rows. Chunks go for real; the document is soft-deleted.
    await db.transaction(async (tx) => {
      await tx.delete(chunks).where(eq(chunks.documentId, documentId));
      await tx
        .delete(documentPages)
        .where(eq(documentPages.documentId, documentId));
      await tx
        .update(documents)
        .set({ deletedAt: new Date() })
        .where(eq(documents.id, documentId));
    });

    expect(await storedPointCount()).toBe(0);

    const counts = await chunkCounts();
    expect(counts.total).toBe(0);

    // Soft-deleted, not gone: the row survives so an audit can still see the
    // document existed, and every user-facing query filters on deletedAt.
    const row = await readDocument();
    expect(row?.deletedAt).not.toBeNull();
  }, 300_000);
});
