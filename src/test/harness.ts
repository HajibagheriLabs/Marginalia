import { randomUUID } from "node:crypto";

import { QdrantClient } from "@qdrant/js-client-rest";
import { eq } from "drizzle-orm";
import { describe, it } from "vitest";

import { db } from "@/db";
import { documentPages, documents, users } from "@/db/schema";
import { assemblePages } from "@/lib/ingest/extract";
import { createQdrantVectorStore, type VectorStore } from "@/lib/vector";

/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THE SHARED INTEGRATION HARNESS.                                          │
 * │                                                                          │
 * │ Four suites used to each carry their own copy of the same three things:  │
 * │ a "do I have credentials" guard, a throwaway user, and a document seeded │
 * │ into Postgres. The copies had already drifted — different skip           │
 * │ conditions for the same requirement, and two spellings of the same       │
 * │ cleanup — which is how a suite ends up silently skipping in CI while     │
 * │ appearing to pass. One implementation, here.                             │
 * │                                                                          │
 * │ WHAT THIS DELIBERATELY DOES NOT DO: fake anything. There are no stub     │
 * │ vectors, no in-memory Postgres and no mock Qdrant. Everything below      │
 * │ creates REAL rows against the configured services, because the           │
 * │ properties these suites exist to prove — a payload filter holds, a       │
 * │ stage is idempotent, a foreign key cascades — are properties of those    │
 * │ services and a mock would only assert that the mock was written to       │
 * │ agree with the test.                                                     │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

/* ========================================================================== *
 * WHAT A SUITE NEEDS, AND WHETHER IT HAS IT
 * ========================================================================== */

export interface Requirements {
  /** DATABASE_URL. Needed by anything touching a real row. */
  postgres?: boolean;
  /** QDRANT_URL + QDRANT_API_KEY. */
  qdrant?: boolean;
  /**
   * A real embedding (or reranking) model. Separate from the two above because
   * it is the slow one: a cold cache downloads weights, and CI can want the
   * database suites without paying for that.
   */
  models?: boolean;
}

/**
 * Why a suite is skipping, or null when it is not.
 *
 * A STRING RATHER THAN A BOOLEAN, deliberately. `describe.skipIf(!configured)`
 * reports "skipped" and nothing else, and a security suite that silently stops
 * running is worse than one that was never written — it still shows green. The
 * reason is printed once per suite by `describeIntegration` so a skipped run in
 * CI says which variable is missing.
 */
export function missingRequirement(need: Requirements): string | null {
  if (need.postgres && !process.env.DATABASE_URL) {
    return "DATABASE_URL is not set";
  }
  if (need.qdrant && !(process.env.QDRANT_URL && process.env.QDRANT_API_KEY)) {
    return "QDRANT_URL / QDRANT_API_KEY are not set";
  }
  if (need.models && process.env.SKIP_MODEL_TESTS === "1") {
    return "SKIP_MODEL_TESTS=1";
  }
  return null;
}

/**
 * True when the environment claims to be CI.
 *
 * Used to turn a skip into a FAILURE. On a developer's fresh clone, skipping an
 * integration suite is the right behaviour — a security test that fails the
 * build for everyone who has not configured a cloud service is a test that gets
 * deleted. In CI the services are provisioned on purpose, so a skip means the
 * workflow is misconfigured and the run must not be green.
 */
export function isCI(): boolean {
  return process.env.CI === "true" || process.env.CI === "1";
}

/* ========================================================================== *
 * THROWAWAY IDENTITIES AND DOCUMENTS
 * ========================================================================== */

/**
 * A collection name nothing else can be using.
 *
 * Every suite that writes vectors makes its own and deletes it afterwards. The
 * real collection is never touched by a test — an isolation suite that upserts
 * adversarial points into the collection the demo reads from would be a very
 * expensive way to prove a filter works.
 */
export function throwawayCollection(label: string): string {
  return `marginalia_test_${label}_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

/** The raw client, for assertions the store's own API deliberately cannot make. */
export function rawQdrant(): QdrantClient {
  return new QdrantClient({
    url: process.env.QDRANT_URL!,
    apiKey: process.env.QDRANT_API_KEY!,
    timeout: 30_000,
    checkCompatibility: false,
  });
}

export function vectorStore(collection: string): VectorStore {
  return createQdrantVectorStore(collection);
}

/**
 * A user that exists only for this suite.
 *
 * Deleting it cascades to documents, pages, chunks, conversations, messages,
 * citations, retrievals and usage events, so `deleteUser` is the entire
 * teardown — which is worth knowing, because a suite that cleans up table by
 * table will miss the table added next month.
 */
export async function seedUser(label: string): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      name: `${label} test`,
      email: `${label}-${randomUUID()}@example.test`,
      emailVerified: true,
    })
    .returning({ id: users.id });
  return user.id;
}

export async function deleteUser(userId: string | undefined): Promise<void> {
  if (!userId) return;
  await db.delete(users).where(eq(users.id, userId));
}

export interface SeededDocument {
  documentId: string;
  pageCount: number;
  /** The concatenated page text, so a test can assert offsets against it. */
  fullText: string;
}

/**
 * A document with its pages, positioned at a chosen pipeline stage.
 *
 * Pages are built by `assemblePages` — the SAME function extraction uses — so
 * the character offsets are produced by production code rather than by a
 * fixture that agrees with the test. Offsets are the ground truth for citation
 * anchoring, and a fixture that computed them itself would prove nothing.
 *
 * `status` defaults to `chunking` because that is where these suites start:
 * beginning at `uploaded` would run extraction, which needs a real file in
 * Vercel Blob.
 */
export async function seedDocument(options: {
  userId: string;
  pages: string[];
  title?: string;
  status?: "uploaded" | "chunking" | "embedding" | "indexing" | "ready";
  embeddingModel?: string;
  embeddingDim?: number;
}): Promise<SeededDocument> {
  // `assemblePages` returns the concatenation as `text`; named `fullText`
  // here because that is what it is to a caller asserting offsets against it.
  const { pages, text: fullText } = assemblePages(options.pages);

  const [created] = await db
    .insert(documents)
    .values({
      userId: options.userId,
      title: options.title ?? "Test Agreement",
      filename: "test.md",
      mimeType: "text/markdown",
      byteSize: fullText.length,
      blobUrl: "https://example.test/test.md",
      blobPathname: `${options.userId}/${randomUUID()}.md`,
      pageCount: pages.length,
      status: options.status ?? "chunking",
      ...(options.embeddingModel
        ? { embeddingModel: options.embeddingModel }
        : {}),
      ...(options.embeddingDim ? { embeddingDim: options.embeddingDim } : {}),
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

  return { documentId: created.id, pageCount: pages.length, fullText };
}

/* ========================================================================== *
 * FIXTURE TEXT
 * ========================================================================== */

/**
 * Prose long enough to chunk, boring enough not to matter.
 *
 * `clauses` controls the size, and size is load-bearing in the pipeline suite:
 * the local provider embeds 32 texts per batch, so a document has to exceed 32
 * passages before "fail on the second batch" is even expressible. An earlier
 * fixture produced nine passages and the failure-injection test ran green while
 * injecting a failure that was never reached.
 */
export function fillerPages(pages: number, clausesPerPage = 40): string[] {
  const clause = (n: number) =>
    `${n}. The Provider shall deliver the services described in Schedule ${n} ` +
    `with reasonable skill and care, and shall notify the Customer in writing ` +
    `of any delay affecting the agreed delivery date for milestone ${n}.`;

  return Array.from({ length: pages }, (_, page) =>
    Array.from({ length: clausesPerPage }, (_, i) =>
      clause(page * clausesPerPage + i + 1),
    ).join("\n\n"),
  );
}

/* ========================================================================== *
 * THE SUITE WRAPPER
 * ========================================================================== */

/**
 * `describe`, with its requirements declared and a loud reason when they are
 * not met.
 *
 * Three behaviours, and the third is the point:
 *
 *   1. Requirements satisfied — an ordinary `describe`.
 *   2. Missing locally — skipped, with the missing variable printed once. A
 *      fresh clone can run `npm test` and see which suites need credentials
 *      rather than a wall of anonymous "skipped".
 *   3. MISSING IN CI — one failing test that says so. CI provisions Postgres
 *      and Qdrant deliberately, so a skip there does not mean "not configured",
 *      it means the workflow broke and nobody would find out: a skipped suite
 *      reports green. The cross-user isolation suite reporting green because it
 *      never ran is precisely the outcome this project cannot afford.
 */
export function describeIntegration(
  name: string,
  need: Requirements,
  body: () => void,
): void {
  const missing = missingRequirement(need);

  if (!missing) {
    describe(name, body);
    return;
  }

  if (isCI()) {
    describe(name, () => {
      it(`must not be skipped in CI (${missing})`, () => {
        throw new Error(
          `Integration suite "${name}" was skipped in CI because ${missing}. ` +
            "CI provisions these services on purpose, so this is a broken " +
            "workflow rather than an unconfigured machine. A skipped suite " +
            "reports green, which is why this fails instead.",
        );
      });
    });
    return;
  }

  console.info(`[test] skipping "${name}" — ${missing}`);
  describe.skip(name, body);
}
