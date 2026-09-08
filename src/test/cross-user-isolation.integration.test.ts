import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";

import { db } from "@/db";
import { chunks, conversations, documents } from "@/db/schema";
import { filterOwnedDocumentIds } from "@/lib/auth-server";
import { assertSameEmbeddingSpace, EmbeddingSpaceError } from "@/lib/embeddings";
import type { VectorPoint, VectorStore } from "@/lib/vector";

import {
  deleteUser,
  describeIntegration,
  rawQdrant,
  seedDocument,
  seedUser,
  throwawayCollection,
  vectorStore,
} from "./harness";

/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ PRIORITY 1 — CROSS-USER ISOLATION.                                       │
 * │                                                                          │
 * │ THE defining security bug of a retrieval application: user A asks a      │
 * │ question and gets an answer grounded in user B's contract, with a        │
 * │ citation, rendered as confidently as any other answer. It fails silently │
 * │ in every direction — no exception, no empty result, no log line — and it │
 * │ is invisible during single-user development, because with one user's     │
 * │ data in the collection a filtered and an unfiltered search return        │
 * │ exactly the same rows.                                                   │
 * │                                                                          │
 * │ The vector store's own suite (src/lib/vector/qdrant.integration.test.ts) │
 * │ proves the payload filter holds at the store. This file covers the       │
 * │ THREE OTHER WAYS IN, which are the ways an application actually leaks:   │
 * │                                                                          │
 * │   1. A CALLER SUPPLYING ANOTHER USER'S document_ids. The ids are         │
 * │      well-formed and the documents are real; only the owner is wrong.    │
 * │   2. THE CHAT ROUTE's scope. It must come from the conversation row,     │
 * │      never from the request body, and the conversation must be owned.    │
 * │   3. A HAND-CRAFTED FILTER. There must be no way to reach the store      │
 * │      with a filter of one's own choosing.                                │
 * │                                                                          │
 * │ Every assertion below is adversarial: user B's data is placed where it   │
 * │ WOULD win — exactly on the query vector, top of the ranking — so a       │
 * │ dropped filter does not merely leak, it dominates. A test where the      │
 * │ other user's data happens to be dissimilar passes with no filter at all. │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

const DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS ?? 384);

/** A unit vector along one axis. */
function axis(index: number): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  vector[index] = 1;
  return vector;
}

describeIntegration(
  "P1 — cross-user isolation",
  { postgres: true, qdrant: true },
  () => {
    const collection = throwawayCollection("p1_isolation");

    let store: VectorStore;
    let userA: string;
    let userB: string;
    let documentA: string;
    let documentB: string;
    let conversationB: string;

    /** The query vector. User B's points sit EXACTLY here — cosine 1.0. */
    const queryVector = axis(0);

    beforeAll(async () => {
      store = vectorStore(collection);
      await store.ensureCollection();

      userA = await seedUser("isolation-a");
      userB = await seedUser("isolation-b");

      const docA = await seedDocument({
        userId: userA,
        pages: ["User A's own agreement. Nothing secret here."],
        title: "A's contract",
        status: "ready",
      });
      const docB = await seedDocument({
        userId: userB,
        pages: ["CONFIDENTIAL: User B's acquisition terms. Price is 40 million."],
        title: "B's confidential contract",
        status: "ready",
      });
      documentA = docA.documentId;
      documentB = docB.documentId;

      // Real chunk rows, so the lexical channel and the trace have something to
      // find. Chunk ids are what a citation resolves to.
      await db.insert(chunks).values([
        {
          documentId: documentA,
          ordinal: 0,
          text: "User A's own agreement. Nothing secret here.",
          tokenCount: 12,
          pageFrom: 1,
          pageTo: 1,
          charStart: 0,
          charEnd: 43,
          sectionPath: null,
          embeddingModel: "test",
        },
        {
          documentId: documentB,
          ordinal: 0,
          text: "CONFIDENTIAL: User B's acquisition terms. Price is 40 million.",
          tokenCount: 14,
          pageFrom: 1,
          pageTo: 1,
          charStart: 0,
          charEnd: 61,
          sectionPath: null,
          embeddingModel: "test",
        },
      ]);

      const [chunkA] = await db
        .select({ id: chunks.id })
        .from(chunks)
        .where(eq(chunks.documentId, documentA));
      const [chunkB] = await db
        .select({ id: chunks.id })
        .from(chunks)
        .where(eq(chunks.documentId, documentB));

      const points: VectorPoint[] = [
        {
          // A's point is deliberately FURTHER from the query than B's.
          id: randomUUID(),
          vector: axis(7),
          payload: {
            user_id: userA,
            document_id: documentA,
            chunk_id: chunkA.id,
            page_from: 1,
            page_to: 1,
          },
        },
        {
          // B's point is ON the query vector. If any filter is dropped, this
          // is the first result, not a lucky one.
          id: randomUUID(),
          vector: queryVector,
          payload: {
            user_id: userB,
            document_id: documentB,
            chunk_id: chunkB.id,
            page_from: 1,
            page_to: 1,
          },
        },
      ];
      await store.upsert(points);

      const [thread] = await db
        .insert(conversations)
        .values({
          userId: userB,
          title: "B's private thread",
          documentIds: [documentB],
        })
        .returning({ id: conversations.id });
      conversationB = thread.id;
    }, 120_000);

    afterAll(async () => {
      await deleteUser(userA);
      await deleteUser(userB);
      await rawQdrant()
        .deleteCollection(collection)
        .catch(() => undefined);
    });

    /* ── PRECONDITION ──────────────────────────────────────────────────────
     * Everything below asserts an absence, and an absence is exactly what a
     * broken fixture also produces. This proves B's point is really there and
     * really wins, so the assertions that follow cannot pass vacuously.
     */
    it("(precondition) user B's point is the top hit for this query", async () => {
      const hits = await store.search({
        userId: userB,
        documentIds: [documentB],
        vector: queryVector,
        limit: 10,
      });

      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].documentId).toBe(documentB);
      // Cosine 1.0 — the best possible match. Nothing user A owns can beat it.
      expect(hits[0].score).toBeGreaterThan(0.99);
    });

    /* ── 1. ANOTHER USER'S DOCUMENT IDS ───────────────────────────────────── */

    it("returns nothing when user A hands the store user B's document id", async () => {
      // The id is real, well-formed, and currently indexed. The ONLY thing
      // wrong with this request is who is making it.
      const hits = await store.search({
        userId: userA,
        documentIds: [documentB],
        vector: queryVector,
        limit: 10,
      });

      expect(hits).toEqual([]);
    });

    it("drops user B's ids from a mixed scope rather than failing open", async () => {
      const hits = await store.search({
        userId: userA,
        documentIds: [documentA, documentB],
        vector: queryVector,
        limit: 10,
      });

      // A partly-invalid scope must not become an unfiltered one — the
      // tempting "if the filter is messy, drop it" is the whole bug.
      expect(hits.every((hit) => hit.documentId === documentA)).toBe(true);
      expect(hits.map((hit) => hit.documentId)).not.toContain(documentB);
    });

    it("narrows a caller-supplied scope to the documents the user owns", async () => {
      // The application-level counterpart of the store filter: a request that
      // names its own scope is intersected with ownership before it is used.
      const owned = await filterOwnedDocumentIds(userA, [documentA, documentB]);
      expect(owned).toEqual([documentA]);

      const none = await filterOwnedDocumentIds(userA, [documentB]);
      expect(none).toEqual([]);
    });

    it("refuses at the embedding-space guard before any vector is searched", async () => {
      // `assertSameEmbeddingSpace` runs FIRST in retrieve(), and it carries a
      // userId for exactly this reason: it doubles as an ownership check, so a
      // foreign document id is rejected before the store is ever reached.
      await expect(
        assertSameEmbeddingSpace([documentB], userA),
      ).rejects.toBeInstanceOf(EmbeddingSpaceError);

      // And the message must not confirm that the document exists — "no such
      // document" and "not yours" have to be indistinguishable, or this becomes
      // an oracle for probing other users' ids.
      await expect(
        assertSameEmbeddingSpace([documentB], userA),
      ).rejects.toThrow(/no longer available/i);

      const invented = randomUUID();
      await expect(
        assertSameEmbeddingSpace([invented], userA),
      ).rejects.toThrow(/no longer available/i);
    });

    /* ── 2. THE CHAT ROUTE'S SCOPE ────────────────────────────────────────── */

    it("scopes a conversation from the owned row, not from the request", async () => {
      /*
       * The chat route reads `conversationId` and one question, and nothing
       * else: scope comes from the conversation row it loads under the
       * session's user id. This asserts the database half of that — the
       * ownership predicate — because the request-body half is a matter of the
       * route's zod schema, checked in the next test.
       */
      const asOwner = await db
        .select({ id: conversations.id, documentIds: conversations.documentIds })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, conversationB),
            eq(conversations.userId, userB),
          ),
        );
      expect(asOwner).toHaveLength(1);
      expect(asOwner[0].documentIds).toEqual([documentB]);

      // The same query as user A — which is exactly what
      // `requireConversationAccess` runs before it calls notFound().
      const asStranger = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, conversationB),
            eq(conversations.userId, userA),
          ),
        );
      expect(asStranger).toEqual([]);
    });

    it("accepts no document ids or history from the chat request body", async () => {
      /*
       * A CLIENT THAT CAN SEND SCOPE CAN SEND SOMEBODY ELSE'S SCOPE.
       *
       * The AI SDK's default transport posts the whole message array every
       * turn, and the obvious server takes it as the thread. This one takes a
       * conversation id and a question. The schema is the boundary, so the
       * schema is what is asserted: a body carrying `documentIds` must not
       * carry them through.
       */
      const { POST } = await import("@/app/api/chat/route");
      expect(typeof POST).toBe("function");

      // Reach the route's own schema rather than reimplementing it here, so
      // this test breaks if a field is ever added.
      const source = await import("node:fs/promises").then((fs) =>
        fs.readFile("src/app/api/chat/route.ts", "utf8"),
      );
      const schema = source.slice(
        source.indexOf("const requestSchema"),
        source.indexOf("export async function POST"),
      );

      expect(schema).toContain("conversationId");
      expect(schema).toContain("question");
      // The three things a hostile client would most like to supply.
      expect(schema).not.toContain("documentIds");
      expect(schema).not.toContain("messages");
      expect(schema).not.toContain("userId");
    });

    /* ── 3. A HAND-CRAFTED FILTER ─────────────────────────────────────────── */

    it("offers no way to reach the store with a caller's own filter", async () => {
      /*
       * The interface has no filter parameter, so a caller cannot express one.
       * This asserts the runtime consequence rather than the type: extra
       * properties smuggled onto the params object are ignored, and the
       * user_id predicate is still applied.
       *
       * The shape below is what someone would actually try — Qdrant's own
       * filter syntax, in the hope that it is merged or spread into the query.
       */
      const hostile = {
        userId: userA,
        documentIds: [documentA],
        vector: queryVector,
        limit: 10,
        filter: { must: [{ key: "user_id", match: { value: userB } }] },
        must: [{ key: "document_id", match: { value: documentB } }],
        with_payload: true,
      } as unknown as Parameters<VectorStore["search"]>[0];

      const hits = await store.search(hostile);

      expect(hits.every((hit) => hit.documentId === documentA)).toBe(true);
      expect(hits.map((hit) => hit.documentId)).not.toContain(documentB);
    });

    it("refuses a search with no user id instead of running unfiltered", async () => {
      // The failure mode this prevents: a refactor drops the argument, the
      // filter silently becomes `document_id` only, and every user's documents
      // with a matching id are searchable. Refusing is the only safe answer.
      await expect(
        store.search({
          userId: "",
          documentIds: [documentA],
          vector: queryVector,
          limit: 5,
        }),
      ).rejects.toThrow();
    });

    it("cannot read another user's chunk rows through Postgres either", async () => {
      /*
       * Isolation is not only a vector-store property. A citation resolves a
       * chunk id to its text, and that read goes through Postgres — so the
       * join back to `documents.user_id` has to hold there too. Without it, a
       * leaked chunk id would still render the passage.
       */
      const [chunkB] = await db
        .select({ id: chunks.id })
        .from(chunks)
        .where(eq(chunks.documentId, documentB));

      const asStranger = await db
        .select({ id: chunks.id, text: chunks.text })
        .from(chunks)
        .innerJoin(documents, eq(chunks.documentId, documents.id))
        .where(and(eq(chunks.id, chunkB.id), eq(documents.userId, userA)));

      expect(asStranger).toEqual([]);

      // The same query as the owner returns it, so the predicate above is what
      // excluded it rather than a typo in the join.
      const asOwner = await db
        .select({ id: chunks.id })
        .from(chunks)
        .innerJoin(documents, eq(chunks.documentId, documents.id))
        .where(and(eq(chunks.id, chunkB.id), eq(documents.userId, userB)));

      expect(asOwner).toHaveLength(1);
    });
  },
);
