import { randomUUID } from "node:crypto";

import { QdrantClient } from "@qdrant/js-client-rest";
import { afterAll, beforeAll, expect, it } from "vitest";

import { describeIntegration } from "@/test/harness";

import { createQdrantVectorStore } from "./qdrant";
import type { VectorPoint, VectorStore } from "./types";

/**
 * THE ISOLATION TEST.
 *
 * This file exists to keep one sentence true: a user can never retrieve another
 * user's passages. See the security rule at the top of `types.ts` for why that
 * needs a test at all rather than a code review — the failure is silent, it
 * produces well-formed ranked results, and it is invisible during single-user
 * development because with one user's data in the collection a filtered and an
 * unfiltered search return exactly the same thing.
 *
 * Two things make this a real test rather than a ritual:
 *
 *   1. THE VECTORS ARE ADVERSARIAL. User B's points are placed EXACTLY on the
 *      query vector — cosine 1.0, the best possible match — while user A's are
 *      deliberately further away. If the filter is dropped, B's points do not
 *      merely leak, they take the top of the ranking. A test where the other
 *      user's data happens to be dissimilar would pass with no filter at all.
 *
 *   2. IT PROVES THE COLLECTION IS NOT EMPTY. The first assertion runs an
 *      UNFILTERED query with the raw client and requires B's points to come
 *      back. Without that, every isolation assertion below could pass simply
 *      because the upsert silently failed, which is the classic way a security
 *      test rots into a test that asserts nothing.
 *
 * It runs against a real Qdrant instance because the thing under test is the
 * filter Qdrant applies, and a mock would only assert that this file builds the
 * filter this file was written to build.
 */

const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS ?? 384);

/*
 * The guard is `describeIntegration` in src/test/harness.ts, shared with the
 * other three integration suites. Without credentials it SKIPS and names the
 * missing variable, so `npm test` stays runnable on a fresh clone — a security
 * test that fails the build for everyone who has not configured a cloud
 * service gets deleted, and a deleted test protects nothing.
 *
 * In CI it FAILS instead. CI provisions Qdrant on purpose, so a skip there is a
 * broken workflow, and a skipped suite reports green.
 */

/** A unit vector along one axis. */
function axis(index: number): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  vector[index] = 1;
  return vector;
}

/** A unit vector near `axis(0)` but not on it — how a real near-miss looks. */
function nearAxisZero(index: number): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  vector[0] = 0.5;
  vector[index] = 1;
  const norm = Math.hypot(...vector);
  return vector.map((value) => value / norm);
}

describeIntegration("P1 — cross-user isolation: the store's payload filter", { qdrant: true }, () => {
  // A throwaway collection per run: this test upserts and deletes, and must
  // never be able to touch the real one.
  const collection = `marginalia_isolation_test_${Date.now()}_${randomUUID().slice(0, 8)}`;

  const userA = randomUUID();
  const userB = randomUUID();
  const documentA = randomUUID();
  const documentB = randomUUID();

  // The query. User B's points sit exactly here.
  const queryVector = axis(0);

  const pointsA: VectorPoint[] = [1, 2, 3].map((n) => ({
    id: randomUUID(),
    vector: nearAxisZero(n),
    payload: {
      user_id: userA,
      document_id: documentA,
      chunk_id: randomUUID(),
      page_from: n,
      page_to: n,
    },
  }));

  const pointsB: VectorPoint[] = [1, 2, 3].map((n) => ({
    id: randomUUID(),
    // Cosine 1.0 against the query: the strongest possible competitor.
    vector: axis(0),
    payload: {
      user_id: userB,
      document_id: documentB,
      chunk_id: randomUUID(),
      page_from: n,
      page_to: n,
    },
  }));

  let store: VectorStore;
  let raw: QdrantClient;

  beforeAll(async () => {
    raw = new QdrantClient({
      url: QDRANT_URL!,
      apiKey: QDRANT_API_KEY!,
      timeout: 30_000,
      checkCompatibility: false,
    });

    store = createQdrantVectorStore(collection);
    await store.ensureCollection();
    await store.upsert([...pointsA, ...pointsB]);
  });

  afterAll(async () => {
    // Never leave a test collection behind on a shared free-tier cluster.
    if (raw) await raw.deleteCollection(collection).catch(() => undefined);
  });

  it("creates the collection idempotently, with payload indexes", async () => {
    // Calling it again on an existing collection must not throw or recreate.
    await expect(store.ensureCollection()).resolves.toBeUndefined();

    const info = await raw.getCollection(collection);
    const vectors = info.config?.params?.vectors as
      | { size?: number; distance?: string }
      | undefined;

    expect(vectors?.size).toBe(DIMENSIONS);
    expect(vectors?.distance).toBe("Cosine");

    // The payload indexes are what keep a filtered search from degrading into
    // a scan as the corpus grows.
    const schema = info.payload_schema ?? {};
    expect(Object.keys(schema).sort()).toEqual(["document_id", "user_id"]);

    // Both users' points really are in there.
    expect(info.points_count).toBe(pointsA.length + pointsB.length);
  });

  it("would surface user B's points to an UNFILTERED query", async () => {
    // The control. This is what the store must never do, executed here with the
    // raw client to prove the data is present and adversarially placed — so
    // that every isolation assertion below is meaningful rather than vacuous.
    const unfiltered = await raw.query(collection, {
      query: queryVector,
      limit: 10,
      with_payload: true,
    });

    const owners = unfiltered.points.map(
      (point) => (point.payload as { user_id: string }).user_id,
    );

    expect(owners).toContain(userB);
    // And B is at the top, because B's vectors sit exactly on the query.
    expect(owners[0]).toBe(userB);
  });

  it("returns only user A's points when user A searches their own document", async () => {
    const hits = await store.search({
      userId: userA,
      documentIds: [documentA],
      vector: queryVector,
      limit: 10,
    });

    expect(hits.length).toBe(pointsA.length);
    for (const hit of hits) {
      expect(hit.documentId).toBe(documentA);
    }

    const returnedChunks = hits.map((hit) => hit.chunkId).sort();
    const expectedChunks = pointsA.map((point) => point.payload.chunk_id).sort();
    expect(returnedChunks).toEqual(expectedChunks);
  });

  it("returns NOTHING when user A asks for user B's document ids", async () => {
    // THE HOSTILE CASE. A caller with user A's session passing document ids
    // belonging to user B — a tampered request body, or a bug that mixed up
    // whose conversation scope it was reading. The user_id clause is the only
    // thing standing between this and a data breach, and B's vectors are the
    // best match in the collection, so a missing clause cannot hide here.
    const hits = await store.search({
      userId: userA,
      documentIds: [documentB],
      vector: queryVector,
      limit: 10,
    });

    expect(hits).toEqual([]);
  });

  it("drops user B's documents from a mixed scope rather than failing open", async () => {
    const hits = await store.search({
      userId: userA,
      documentIds: [documentA, documentB],
      vector: queryVector,
      limit: 10,
    });

    expect(hits.length).toBe(pointsA.length);
    expect(hits.every((hit) => hit.documentId === documentA)).toBe(true);
    expect(hits.some((hit) => hit.documentId === documentB)).toBe(false);
  });

  it("isolates in both directions", async () => {
    // Not symmetry for its own sake: a filter built from the wrong variable
    // can easily be correct for one user and wrong for the other.
    const hits = await store.search({
      userId: userB,
      documentIds: [documentB],
      vector: queryVector,
      limit: 10,
    });

    expect(hits.length).toBe(pointsB.length);
    expect(hits.every((hit) => hit.documentId === documentB)).toBe(true);
    // B's points sit on the query vector, so the score is ~1.
    expect(hits[0].score).toBeGreaterThan(0.99);
  });

  it("returns nothing when no documents are in scope", async () => {
    const hits = await store.search({
      userId: userA,
      documentIds: [],
      vector: queryVector,
      limit: 10,
    });

    expect(hits).toEqual([]);
  });

  it("refuses a search with no userId", async () => {
    await expect(
      store.search({
        userId: "",
        documentIds: [documentA],
        vector: queryVector,
        limit: 10,
      }),
    ).rejects.toThrow(/unscoped/i);
  });

  it("carries page numbers through the payload", async () => {
    const hits = await store.search({
      userId: userA,
      documentIds: [documentA],
      vector: queryVector,
      limit: 10,
    });

    for (const hit of hits) {
      const source = pointsA.find(
        (point) => point.payload.chunk_id === hit.chunkId,
      )!;
      expect(hit.pageFrom).toBe(source.payload.page_from);
      expect(hit.pageTo).toBe(source.payload.page_to);
    }
  });

  it("deletes one document's points without touching the other user's", async () => {
    await store.deleteByDocument(documentA);

    const aHits = await store.search({
      userId: userA,
      documentIds: [documentA],
      vector: queryVector,
      limit: 10,
    });
    expect(aHits).toEqual([]);

    // B is untouched. Re-ingest and delete must never be able to reach across.
    const bHits = await store.search({
      userId: userB,
      documentIds: [documentB],
      vector: queryVector,
      limit: 10,
    });
    expect(bHits.length).toBe(pointsB.length);
  });
});
