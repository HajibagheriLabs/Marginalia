import { randomUUID } from "node:crypto";

import { QdrantClient } from "@qdrant/js-client-rest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";

import { db } from "@/db";
import { chunks, documentPages, documents, users } from "@/db/schema";
import { getEmbeddingProvider, type EmbeddingProvider } from "@/lib/embeddings";
import { assemblePages } from "@/lib/ingest/extract";
import { runPipeline } from "@/lib/ingest/pipeline";
import { createQdrantVectorStore, type VectorStore } from "@/lib/vector";
import { describeIntegration } from "@/test/harness";

import { retrieve } from "./index";
import { searchLexical } from "./lexical";
import { RetrievalError } from "./types";

/**
 * HYBRID RETRIEVAL, against real infrastructure.
 *
 * Real Postgres, real Qdrant, the real embedding model, and documents put there
 * by the real ingestion pipeline. Every property under test is a property of
 * how those pieces behave together:
 *
 *   - the LEXICAL channel finds an exact identifier the DENSE channel misses,
 *     which is the entire justification for running two channels;
 *   - document filters hold, so a search cannot reach outside its scope;
 *   - mixed embedding spaces are refused rather than silently fused.
 *
 * The first of those is the one worth writing carefully. It is easy to write a
 * test that "proves" hybrid search works by asserting the right passage comes
 * back — which it would with dense alone. The assertion here is stronger and
 * more specific: dense is run ON ITS OWN and shown to MISS, and only then is
 * the fused result shown to find it. A test that cannot fail when the lexical
 * channel is deleted is not testing the lexical channel.
 */


/**
 * A contract containing one deliberately unguessable identifier.
 *
 * "ZX-4471-Q" and "apixaban" are chosen because they are exactly what a
 * bi-encoder cannot handle: a token with no semantic neighbourhood. The
 * embedding of a query containing it is dominated by the ordinary words around
 * it, so dense search returns passages that are ABOUT the same topic and has no
 * way to prefer the one that literally contains the string.
 */
function contractPages(): string[] {
  const filler = (n: number) =>
    `${n}. The Provider shall perform the services with reasonable skill and ` +
    `care, and shall notify the Customer in writing of any delay affecting ` +
    `the agreed delivery date for the applicable milestone under this ` +
    `agreement, including any delay caused by circumstances beyond its ` +
    `reasonable control.`;

  const page1 = [
    "# Master Services Agreement",
    "## Article 7 - Termination",
    "7.1 Either party may terminate this agreement for convenience by giving " +
      "thirty (30) days prior written notice to the other party.",
    ...Array.from({ length: 10 }, (_, i) => filler(i + 1)),
  ].join("\n\n");

  // DISTRACTORS. Deliberately near-identical to the target clause minus the
  // identifier: same vocabulary, same shape, same topic. This is what makes the
  // dense channel fail — every one of these embeds close to a question about
  // part-number requirements, and the one that actually carries "ZX-4471-Q"
  // has no vector advantage over them, because the identifier contributes
  // almost nothing to a 384-dimensional summary of the sentence.
  const specDistractor = (n: number) =>
    `9.${n} The Provider shall supply units conforming to the requirements ` +
    `for part number ${["HK", "PM", "TR", "VB"][n % 4]}-${1000 + n * 7}-${
      "ABCDEFGH"[n % 8]
    } as set out in Schedule D, and shall not substitute an equivalent ` +
    `without the Customer's prior written consent.`;

  // Two dozen passages that are TOPICALLY the answer to "what are the
  // requirements for part number X" — just for the wrong X.
  const page2 = [
    "## Article 9 - Specifications",
    ...Array.from({ length: 48 }, (_, i) => specDistractor(i + 10)),
    ...Array.from({ length: 10 }, (_, i) => filler(i + 20)),
  ].join("\n\n");

  // THE TARGET, deliberately filed somewhere the question does not sound
  // like. The identifier is real and unique, but the sentence around it is
  // about packaging, not about requirements or specifications. This is the
  // ordinary case that defeats a bi-encoder: the passage a reader needs is
  // not the passage that most resembles their question.
  const page3 = [
    "## Article 12 - Clinical supply",
    "12.7 Units bearing part number ZX-4471-Q shall be packaged in " +
      "tamper-evident cartons and labelled with the batch identifier " +
      "before despatch from the warehouse.",
    "12.2 Where the study protocol requires anticoagulation, apixaban shall " +
      "be supplied by the Provider at its own cost for the duration of the " +
      "trial.",
    ...Array.from({ length: 10 }, (_, i) => filler(i + 40)),
  ].join("\n\n");

  return [page1, page2, page3];
}

/** A second, unrelated document, so scope filtering has something to exclude. */
function policyPages(): string[] {
  return [
    [
      "# Information Security Policy",
      "## 3 Access control",
      "3.1 Access to production systems is granted on the principle of least " +
        "privilege and is reviewed quarterly by the security team.",
      "3.2 Multi-factor authentication is mandatory for all administrative " +
        "accounts without exception, including break-glass accounts.",
      ...Array.from(
        { length: 10 },
        (_, i) =>
          `3.${i + 3} Records of access reviews are retained for seven years ` +
          `and are available to auditors on request.`,
      ),
    ].join("\n\n"),
  ];
}

describeIntegration("P4 — retrieval correctness: hybrid search", { postgres: true, qdrant: true, models: true }, () => {
  const collection = `marginalia_retrieval_test_${Date.now()}_${randomUUID().slice(0, 8)}`;

  let raw: QdrantClient;
  let store: VectorStore;
  let provider: EmbeddingProvider;

  let userId: string;
  let otherUserId: string;
  let contractId: string;
  let policyId: string;

  /** Ingest a document through the real pipeline and return its id. */
  async function ingest(
    owner: string,
    title: string,
    pageTexts: string[],
  ): Promise<string> {
    const { pages } = assemblePages(pageTexts);

    const [created] = await db
      .insert(documents)
      .values({
        userId: owner,
        title,
        filename: `${title.toLowerCase().replace(/\s+/g, "-")}.md`,
        mimeType: "text/markdown",
        byteSize: 4096,
        blobUrl: `https://example.test/${randomUUID()}.md`,
        blobPathname: `${owner}/${randomUUID()}.md`,
        pageCount: pages.length,
        // Extraction has already happened; the pipeline starts at chunking.
        status: "chunking",
      })
      .returning({ id: documents.id });

    await db.insert(documentPages).values(
      pages.map((page) => ({
        documentId: created.id,
        pageNumber: page.pageNumber,
        text: page.text,
        charStart: page.charStart,
        charEnd: page.charEnd,
      })),
    );

    const outcome = await runPipeline(created.id, owner, {
      embeddings: provider,
      vectors: store,
    });
    expect(outcome.status).toBe("ready");

    return created.id;
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
    await provider.embedQuery("warm up");

    const [owner, other] = await db
      .insert(users)
      .values([
        {
          name: "Retrieval Test",
          email: `retrieval-${randomUUID()}@example.test`,
          emailVerified: true,
        },
        {
          name: "Other User",
          email: `retrieval-other-${randomUUID()}@example.test`,
          emailVerified: true,
        },
      ])
      .returning({ id: users.id });
    userId = owner.id;
    otherUserId = other.id;

    contractId = await ingest(userId, "Master Services Agreement", contractPages());
    policyId = await ingest(userId, "Information Security Policy", policyPages());
  }, 600_000);

  afterAll(async () => {
    if (userId) await db.delete(users).where(eq(users.id, userId));
    if (otherUserId) await db.delete(users).where(eq(users.id, otherUserId));
    if (raw) await raw.deleteCollection(collection).catch(() => undefined);
  });

  /* ====================================================================== *
   * THE CASE THE LEXICAL CHANNEL EXISTS FOR
   * ====================================================================== */

  it("finds an exact part number the dense channel misses", async () => {
    const query = "What are the requirements for part number ZX-4471-Q?";

    const all = await db
      .select({ id: chunks.id, text: chunks.text })
      .from(chunks)
      .where(eq(chunks.documentId, contractId));
    const truth = all.find((chunk) => chunk.text.includes("ZX-4471-Q"))!;
    expect(truth).toBeDefined();

    // ---- DENSE ALONE ----------------------------------------------------
    const vector = await provider.embedQuery(query);
    const denseHits = await store.search({
      userId,
      documentIds: [contractId],
      vector,
      limit: 5,
    });
    const denseRank =
      denseHits.findIndex((hit) => hit.chunkId === truth.id) + 1 || null;

    // ---- LEXICAL ALONE --------------------------------------------------
    const lexical = await searchLexical({
      userId,
      documentIds: [contractId],
      query,
      limit: 5,
    });
    const lexicalRank =
      lexical.hits.findIndex((hit) => hit.chunkId === truth.id) + 1 || null;

    console.info(
      `[retrieval-test] ZX-4471-Q — dense rank ${denseRank ?? "miss"}, ` +
        `lexical rank ${lexicalRank ?? "miss"}`,
    );

    // The lexical channel must find it, at the very top: it is the only chunk
    // in the document containing that token. It gets there through the RELAXED
    // pass — the strict AND reading rejects the passage for lacking the word
    // "requirements", which is the whole reason that second pass exists.
    // THE POINT OF THE TEST. Dense is buried under two dozen passages saying
    // almost exactly the same thing without the identifier, so it does not
    // surface the one that matters; lexical puts it first, because that token
    // appears in exactly one chunk of the document.
    expect(denseRank).toBeNull();
    expect(lexicalRank).toBe(1);


    // ---- FUSED ----------------------------------------------------------
    // Whatever dense did, the fused result must surface it. This is the
    // assertion that matters: the passage carrying the answer reaches the model.
    const result = await retrieve({
      userId,
      documentIds: [contractId],
      query,
      deps: { embeddings: provider, vectors: store, reranker: null },
    });

    const used = result.passages.flatMap((passage) => passage.chunkIds);
    expect(used).toContain(truth.id);

    // And the trace records HOW it was found, which is the product feature.
    const traced = result.candidates.find(
      (candidate) => candidate.chunkId === truth.id,
    )!;
    expect(traced).toBeDefined();
    expect(traced.lexicalRank).toBe(1);
    expect(traced.lexicalScore).toBeGreaterThan(0);
    expect(traced.used).toBe(true);
    expect(["lexical", "both"]).toContain(traced.channel);
  }, 300_000);

  it("falls back to an OR reading when the strict AND matches nothing", async () => {
    // "photosynthesis" appears nowhere in the corpus, so the strict AND reading
    // — which requires EVERY term — cannot match anything at all. Without the
    // relaxed second pass the lexical channel would return nothing for a
    // question that is three-quarters answerable, which is the everyday case
    // that would silently reduce hybrid search to dense-only.
    const lexical = await searchLexical({
      userId,
      documentIds: [contractId],
      query: "tamper-evident cartons photosynthesis",
      limit: 5,
    });

    expect(lexical.relaxed).toBe(true);
    expect(lexical.hits.length).toBeGreaterThan(0);

    const all = await db
      .select({ id: chunks.id, text: chunks.text })
      .from(chunks)
      .where(eq(chunks.documentId, contractId));
    const packaging = all.find((chunk) => chunk.text.includes("tamper-evident"))!;
    expect(lexical.hits[0].chunkId).toBe(packaging.id);
  }, 120_000);

  it("finds a drug name through the lexical channel", async () => {
    const query = "Who pays for apixaban during the trial?";

    const all = await db
      .select({ id: chunks.id, text: chunks.text })
      .from(chunks)
      .where(eq(chunks.documentId, contractId));
    const truth = all.find((chunk) => chunk.text.includes("apixaban"))!;
    expect(truth).toBeDefined();

    const lexical = await searchLexical({
      userId,
      documentIds: [contractId],
      query,
      limit: 5,
    });
    expect(lexical.hits[0]?.chunkId).toBe(truth.id);

    const result = await retrieve({
      userId,
      documentIds: [contractId],
      query,
      deps: { embeddings: provider, vectors: store, reranker: null },
    });
    expect(result.passages.flatMap((p) => p.chunkIds)).toContain(truth.id);
  }, 300_000);

  it("still answers a paraphrased question with no shared vocabulary", async () => {
    // The mirror image: no exact token overlap at all, so the dense channel is
    // doing the work. Both channels have to earn their place.
    const result = await retrieve({
      userId,
      documentIds: [contractId],
      query: "How much warning must be given to end the contract early?",
      deps: { embeddings: provider, vectors: store, reranker: null },
    });

    const text = result.passages.map((passage) => passage.text).join("\n");
    expect(text).toContain("thirty (30) days");

    const dense = result.candidates.filter(
      (candidate) => candidate.denseRank !== null,
    );
    expect(dense.length).toBeGreaterThan(0);
  }, 300_000);

  /* ====================================================================== *
   * SCOPE
   * ====================================================================== */

  it("respects the document filter", async () => {
    // A query whose answer lives ONLY in the policy document, asked with the
    // contract in scope. It must come back empty-handed rather than reaching
    // into a document the caller did not select.
    const result = await retrieve({
      userId,
      documentIds: [contractId],
      query: "Is multi-factor authentication mandatory for admin accounts?",
      deps: { embeddings: provider, vectors: store, reranker: null },
    });

    for (const candidate of result.candidates) {
      expect(candidate.documentId).toBe(contractId);
    }
    for (const passage of result.passages) {
      expect(passage.documentId).toBe(contractId);
    }

    // The same question with the right document in scope does find it, so the
    // assertion above is about the filter and not about the question.
    const scoped = await retrieve({
      userId,
      documentIds: [policyId],
      query: "Is multi-factor authentication mandatory for admin accounts?",
      deps: { embeddings: provider, vectors: store, reranker: null },
    });
    expect(scoped.passages.map((p) => p.text).join("\n")).toContain(
      "Multi-factor authentication",
    );
  }, 300_000);

  it("searches across several documents when several are in scope", async () => {
    const result = await retrieve({
      userId,
      documentIds: [contractId, policyId],
      query: "What are the review and notice requirements?",
      k: 8,
      deps: { embeddings: provider, vectors: store, reranker: null },
    });

    const scoped = new Set(result.candidates.map((c) => c.documentId));
    for (const documentId of scoped) {
      expect([contractId, policyId]).toContain(documentId);
    }
    expect(result.candidates.length).toBeGreaterThan(0);
  }, 300_000);

  it("refuses to search another user's document", async () => {
    // The ownership guard runs before any channel does. The message must not
    // reveal whether the id exists.
    await expect(
      retrieve({
        userId: otherUserId,
        documentIds: [contractId],
        query: "termination notice",
        deps: { embeddings: provider, vectors: store, reranker: null },
      }),
    ).rejects.toThrow(RetrievalError);
  }, 300_000);

  /* ====================================================================== *
   * MIXED EMBEDDING SPACES
   * ====================================================================== */

  it("refuses a search across mixed embedding spaces", async () => {
    // Rewrite one document's recorded space to look like an older model, which
    // is exactly what editing EMBEDDING_MODEL under an existing corpus does.
    await db
      .update(documents)
      .set({ embeddingModel: "Xenova/all-MiniLM-L6-v2", embeddingDim: 384 })
      .where(eq(documents.id, policyId));

    try {
      const attempt = retrieve({
        userId,
        documentIds: [contractId, policyId],
        query: "notice period",
        deps: { embeddings: provider, vectors: store, reranker: null },
      });

      await expect(attempt).rejects.toThrow(RetrievalError);
      // The message has to name the problem and the fix, not just fail.
      await expect(attempt).rejects.toThrow(/cannot be compared/i);
    } finally {
      await db
        .update(documents)
        .set({
          embeddingModel: provider.model,
          embeddingDim: provider.dimensions,
        })
        .where(eq(documents.id, policyId));
    }
  }, 300_000);

  /* ====================================================================== *
   * THE TRACE, AND ASSEMBLY
   * ====================================================================== */

  it("returns a complete trace, including candidates that lost", async () => {
    const result = await retrieve({
      userId,
      documentIds: [contractId],
      query: "termination for convenience notice period",
      k: 3,
      deps: { embeddings: provider, vectors: store, reranker: null },
    });

    expect(result.candidates.length).toBeGreaterThan(result.passages.length);

    const usedInTrace = result.candidates.filter((c) => c.used);
    const usedInContext = new Set(
      result.passages.flatMap((passage) => passage.chunkIds),
    );
    // The trace and the context cannot disagree about what the model saw.
    expect(new Set(usedInTrace.map((c) => c.chunkId))).toEqual(usedInContext);

    for (const candidate of result.candidates) {
      // Every candidate was found by at least one channel, and its rank in a
      // channel that missed it is null rather than zero.
      expect(candidate.denseRank !== null || candidate.lexicalRank !== null).toBe(
        true,
      );
      if (candidate.denseRank === null) expect(candidate.denseScore).toBeNull();
      if (candidate.lexicalRank === null) {
        expect(candidate.lexicalScore).toBeNull();
      }
      expect(candidate.rrfScore).toBeGreaterThan(0);
      // Reranking was explicitly off.
      expect(candidate.rerankScore).toBeNull();
    }

    expect(result.stats.rerankModel).toBeNull();
    expect(result.stats.rerankedCount).toBe(0);
    expect(result.stats.contextTokens).toBeGreaterThan(0);
    expect(result.stats.timings.totalMs).toBeGreaterThanOrEqual(0);
  }, 300_000);

  it("numbers passages from 1 and never repeats a chunk", async () => {
    const result = await retrieve({
      userId,
      documentIds: [contractId, policyId],
      query: "notice, access review, and delivery obligations",
      k: 6,
      deps: { embeddings: provider, vectors: store, reranker: null },
    });

    result.passages.forEach((passage, index) => {
      expect(passage.marker).toBe(index + 1);
      expect(passage.chunkIds).toContain(passage.primaryChunkId);
      expect(passage.text.length).toBeGreaterThan(0);
    });

    // Merging must not leave a chunk in two passages — that would put the same
    // sentence under two citation markers.
    const seen = result.passages.flatMap((passage) => passage.chunkIds);
    expect(new Set(seen).size).toBe(seen.length);

    // The assembled context respects its budget.
    const total = result.passages.reduce((sum, p) => sum + p.tokenCount, 0);
    expect(result.stats.contextTokens).toBe(total);
    expect(total).toBeLessThanOrEqual(4_000);
  }, 300_000);

  /* ====================================================================== *
   * EDGES
   * ====================================================================== */

  it("reports a question with no searchable terms", async () => {
    // Every word a stopword: websearch_to_tsquery is empty. The interface needs
    // to tell these apart from "these documents don't mention it".
    const lexical = await searchLexical({
      userId,
      documentIds: [contractId],
      query: "what about it?",
      limit: 10,
    });

    expect(lexical.hits).toEqual([]);
    expect(lexical.queryEmpty).toBe(true);

    // The line is narrower than it looks: "ones" survives stemming as 'one',
    // so this one is NOT empty even though it reads like the same question.
    // Only Postgres can tell, which is why the code asks rather than guesses.
    const notEmpty = await searchLexical({
      userId,
      documentIds: [contractId],
      query: "what about the ones?",
      limit: 10,
    });
    expect(notEmpty.queryEmpty).toBe(false);
  }, 120_000);

  it("handles quoted phrases and negation", async () => {
    // websearch_to_tsquery semantics, which plainto_tsquery would silently
    // ignore. The negated term must exclude the passage that carries it.
    const withTerm = await searchLexical({
      userId,
      documentIds: [contractId],
      query: '"written notice"',
      limit: 10,
    });
    expect(withTerm.hits.length).toBeGreaterThan(0);

    const negated = await searchLexical({
      userId,
      documentIds: [contractId],
      query: "notice -apixaban",
      limit: 50,
    });

    const all = await db
      .select({ id: chunks.id, text: chunks.text })
      .from(chunks)
      .where(eq(chunks.documentId, contractId));
    const apixabanChunk = all.find((c) => c.text.includes("apixaban"))!;

    expect(negated.hits.map((hit) => hit.chunkId)).not.toContain(
      apixabanChunk.id,
    );
  }, 120_000);

  it("refuses an empty scope or an empty question", async () => {
    await expect(
      retrieve({
        userId,
        documentIds: [],
        query: "anything",
        deps: { embeddings: provider, vectors: store, reranker: null },
      }),
    ).rejects.toThrow(RetrievalError);

    await expect(
      retrieve({
        userId,
        documentIds: [contractId],
        query: "   ",
        deps: { embeddings: provider, vectors: store, reranker: null },
      }),
    ).rejects.toThrow(RetrievalError);
  }, 120_000);
});
