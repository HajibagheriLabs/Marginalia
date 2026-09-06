import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { chunks, documentPages, documents, users } from "@/db/schema";
import { getEmbeddingProvider } from "@/lib/embeddings";
import { assemblePages, paginateText } from "@/lib/ingest/extract";
import { runChunking } from "@/lib/ingest/chunk-stage";
import { runEmbedding } from "@/lib/ingest/embed-stage";
import { runIndexing } from "@/lib/ingest/index-stage";
import { env } from "@/lib/env";
import { createQdrantVectorStore } from "@/lib/vector/qdrant";
import type { VectorStore } from "@/lib/vector";

import { ingestHash } from "./config";
import {
  EVALS_DIR,
  readDatasetText,
  readManifest,
  sha256,
  type DatasetDocument,
} from "./dataset";
import type { ChunkConfig } from "./types";

/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THE EVAL CORPUS, INSIDE THE REAL SYSTEM.                                 │
 * │                                                                          │
 * │ The eval does not simulate retrieval. It puts three real documents       │
 * │ through the SHIPPING chunking, embedding, and indexing stages, into real │
 * │ Postgres rows and a real Qdrant collection, and then asks the shipping   │
 * │ `retrieve()` and `answer()` about them. A harness that reimplemented any │
 * │ of that would be measuring itself.                                       │
 * │                                                                          │
 * │ TWO THINGS ARE ISOLATED FROM PRODUCTION, both by construction:           │
 * │                                                                          │
 * │   - A DEDICATED USER ROW. Every query in this codebase is filtered by    │
 * │     `user_id`, so an eval user's documents are invisible to every real   │
 * │     account for exactly the same reason one account's are invisible to   │
 * │     another. No special case, no flag: the eval is a tenant.             │
 * │   - A SEPARATE QDRANT COLLECTION, `<QDRANT_COLLECTION>_eval`. Sharing    │
 * │     one would mean a chunk-size sweep deleting and rewriting points      │
 * │     under a live index between runs.                                     │
 * │                                                                          │
 * │ WHAT IS NOT EXERCISED, stated plainly rather than left to be discovered: │
 * │ EXTRACTION. The corpus is committed as plain text, so `runExtraction` —  │
 * │ which downloads from Blob and parses a PDF or DOCX — is replaced by the  │
 * │ ~15 lines below that call the same `paginateText` and write the same     │
 * │ `document_pages` rows. That is deliberate (see dataset.ts: page numbers  │
 * │ must not move under a PDF-parser upgrade) and it means this eval says    │
 * │ nothing about PDF text extraction quality. evals/README.md repeats this  │
 * │ where someone reading a score will see it.                              │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

/**
 * A fixed uuid for the eval tenant.
 *
 * Fixed rather than random so that re-runs reuse the same rows instead of
 * leaving a new orphaned user behind on every invocation, and so a human can
 * find the eval's data in the database without guessing. It is a valid v4 uuid
 * with a recognisable prefix; it belongs to no real person and never will,
 * because sign-up mints its own.
 */
const EVAL_USER_ID = "e0a10000-0000-4000-8000-000000000001";
const EVAL_USER_EMAIL = "eval@marginalia.invalid";

/** `.invalid` is reserved by RFC 2606 and can never be a deliverable address. */
const CACHE_PATH = path.join(EVALS_DIR, "results", ".ingest-cache.json");

export interface Corpus {
  userId: string;
  store: VectorStore;
  /** dataset document id -> the `documents` row id it was ingested as. */
  documentIds: Map<string, string>;
  /** In manifest order — the retrieval scope for every question. */
  scope: string[];
  /** dataset document id -> sha256 of its committed text. */
  digests: Record<string, string>;
  documents: DatasetDocument[];
  /** Totals, for the report header. */
  stats: { pages: number; chunks: number };
  /** True when this run had to re-embed rather than reuse the cache. */
  ingested: boolean;
  ingestMs: number;
}

interface IngestCache {
  hash: string;
  documentIds: Record<string, string>;
  stats: { pages: number; chunks: number };
}

function evalCollection(): string {
  return `${env.QDRANT_COLLECTION}_eval`;
}

/**
 * Bring the corpus up to date for this chunk config, reusing it when possible.
 *
 * Embedding 700 KB of text locally is minutes of CPU, and the chunk config is
 * the only thing that changes what gets embedded. So the whole ingest is
 * cached against `ingestHash(chunk, corpus, embeddingModel)`: sweeping ten RRF
 * constants re-ingests zero times, and only a `--target-tokens` change pays.
 *
 * The cache records the DOCUMENT ROW IDS, and they are re-verified against the
 * database before being trusted — a cache file pointing at rows somebody
 * dropped would otherwise produce an eval that silently retrieves nothing and
 * reports it as a recall collapse.
 */
export async function prepareCorpus(
  chunk: ChunkConfig,
  options: { force: boolean; log: (line: string) => void },
): Promise<Corpus> {
  const startedAt = Date.now();
  const manifest = await readManifest();
  const provider = getEmbeddingProvider();
  const store = createQdrantVectorStore(evalCollection());

  const texts = new Map<string, string>();
  const digests: Record<string, string> = {};
  for (const document of manifest.documents) {
    const text = await readDatasetText(document);
    texts.set(document.id, text);
    digests[document.id] = sha256(text);

    if (digests[document.id] !== document.sha256) {
      options.log(
        `  ! ${document.id}: committed text does not match the manifest sha256. ` +
          `Run \`npm run eval:fetch -- --update\` or restore the file.`,
      );
    }
  }

  const hash = ingestHash(chunk, digests, provider.model);
  const cached = options.force ? null : await readCache();

  if (cached && cached.hash === hash) {
    const verified = await verifyDocuments(cached.documentIds);
    if (verified) {
      options.log(`corpus: reusing ingest ${hash} (${cached.stats.chunks} passages)`);
      return {
        userId: EVAL_USER_ID,
        store,
        documentIds: new Map(Object.entries(cached.documentIds)),
        scope: manifest.documents.map(
          (document) => cached.documentIds[document.id],
        ),
        digests,
        documents: manifest.documents,
        stats: cached.stats,
        ingested: false,
        ingestMs: Date.now() - startedAt,
      };
    }
    options.log(
      `corpus: cache ${hash} names rows that are gone; re-ingesting`,
    );
  }

  options.log(`corpus: ingesting ${manifest.documents.length} documents as ${hash}`);

  await ensureEvalUser();
  await store.ensureCollection();

  // Everything from a previous ingest goes first. Chunk ids are minted fresh on
  // every ingest, so keeping old rows would leave vector points that no chunk
  // row can hydrate — the exact orphan the production chunk stage deletes
  // points to avoid.
  await clearPreviousIngest(store);

  const documentIds = new Map<string, string>();
  let totalPages = 0;
  let totalChunks = 0;

  for (const document of manifest.documents) {
    const text = texts.get(document.id)!;
    const rowId = await ingestOne(document, text, chunk, store, (line) =>
      options.log(`  ${line}`),
    );
    documentIds.set(document.id, rowId);

    const [counts] = await db
      .select({
        pages: sql<number>`(select count(*)::int from ${documentPages} where ${documentPages.documentId} = ${rowId})`,
        chunks: sql<number>`(select count(*)::int from ${chunks} where ${chunks.documentId} = ${rowId})`,
      })
      .from(documents)
      .where(eq(documents.id, rowId));

    totalPages += counts.pages;
    totalChunks += counts.chunks;
  }

  const stats = { pages: totalPages, chunks: totalChunks };
  await writeCache({
    hash,
    documentIds: Object.fromEntries(documentIds),
    stats,
  });

  return {
    userId: EVAL_USER_ID,
    store,
    documentIds,
    scope: manifest.documents.map((document) => documentIds.get(document.id)!),
    digests,
    documents: manifest.documents,
    stats,
    ingested: true,
    ingestMs: Date.now() - startedAt,
  };
}

/**
 * One document, through the pipeline.
 *
 * Extraction is done inline (see the header); chunking, embedding, and indexing
 * are the shipping stage functions, called in the order the orchestrator calls
 * them. `runEmbedding` returns `{ complete: false }` when it runs out of its
 * time budget, exactly as it does in production, so it is called in a loop —
 * the same loop the orchestrator runs, minus the HTTP re-invocation.
 */
async function ingestOne(
  document: DatasetDocument,
  text: string,
  chunk: ChunkConfig,
  store: VectorStore,
  log: (line: string) => void,
): Promise<string> {
  // The same two functions `runExtraction` uses for a TXT upload: split into
  // synthesized ~3,000-character blocks, then compute each block's span in the
  // concatenated document text. `assemblePages` is the ONLY place offsets are
  // derived anywhere in the codebase, so a citation resolved in the eval lands
  // on the same characters it would in the product.
  const { pages } = assemblePages(paginateText(text));

  const [row] = await db
    .insert(documents)
    .values({
      userId: EVAL_USER_ID,
      title: document.title,
      filename: document.filename,
      mimeType: "text/plain",
      byteSize: Buffer.byteLength(text, "utf8"),
      // Nothing ever fetches these: the eval skips extraction, which is the
      // only stage that reads a blob. Recorded as a non-resolving URL rather
      // than a plausible one, so a future caller that DOES try to fetch it
      // fails loudly instead of hitting somebody's storage.
      blobUrl: `https://eval.invalid/${document.filename}`,
      blobPathname: `eval/${document.filename}`,
      status: "chunking",
      pageCount: pages.length,
    })
    .returning({ id: documents.id });

  await db.insert(documentPages).values(
    pages.map((page) => ({
      documentId: row.id,
      pageNumber: page.pageNumber,
      text: page.text,
      charStart: page.charStart,
      charEnd: page.charEnd,
    })),
  );

  const deps = {
    vectors: store,
    chunkOptions: {
      targetTokens: chunk.targetTokens,
      maxTokens: chunk.maxTokens,
      minTokens: chunk.minTokens,
      overlapRatio: chunk.overlapRatio,
      sectionBreakRatio: chunk.sectionBreakRatio,
    },
    // Generous: this is a CLI on a workstation, not a 300-second function.
    deadline: Date.now() + 30 * 60_000,
  };

  const chunked = await runChunking(row.id, EVAL_USER_ID, deps);
  log(`${document.id}: ${pages.length} blocks, ${chunked.detail ?? ""}`);

  // The embedding stage yields when its budget runs out; production re-invokes
  // it over HTTP, and here it is simply called again.
  for (let pass = 0; ; pass += 1) {
    const result = await runEmbedding(row.id, EVAL_USER_ID, deps);
    log(`${document.id}: embed pass ${pass + 1} — ${result.detail ?? ""}`);
    if (result.complete) break;
    if (pass > 50) throw new Error(`${document.id}: embedding is not converging`);
  }

  await runIndexing(row.id, EVAL_USER_ID, deps);
  await db
    .update(documents)
    .set({ status: "ready", readyAt: new Date() })
    .where(eq(documents.id, row.id));

  return row.id;
}

/* ========================================================================== *
 * THE TENANT
 * ========================================================================== */

async function ensureEvalUser(): Promise<void> {
  await db
    .insert(users)
    .values({
      id: EVAL_USER_ID,
      name: "Evaluation harness",
      email: EVAL_USER_EMAIL,
      emailVerified: true,
    })
    .onConflictDoNothing({ target: users.id });
}

/**
 * Remove everything a previous ingest left behind.
 *
 * Vectors first, then rows — the same outward-in order as `deleteDocument`, and
 * for the same reason: the rows are how the vectors are found. Chunks and pages
 * cascade from `documents`, so deleting the document rows is sufficient, but
 * the vector points do not and have to be filtered on `user_id`.
 */
async function clearPreviousIngest(store: VectorStore): Promise<void> {
  await store.deleteByUser(EVAL_USER_ID);
  await db.delete(documents).where(eq(documents.userId, EVAL_USER_ID));
}

/** Do the cached row ids still exist, ready, and owned by the eval user? */
async function verifyDocuments(
  documentIds: Record<string, string>,
): Promise<boolean> {
  const ids = Object.values(documentIds);
  if (ids.length === 0) return false;

  for (const id of ids) {
    const [row] = await db
      .select({ status: documents.status })
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.userId, EVAL_USER_ID)))
      .limit(1);
    if (!row || row.status !== "ready") return false;
  }
  return true;
}

async function readCache(): Promise<IngestCache | null> {
  try {
    return JSON.parse(await readFile(CACHE_PATH, "utf8")) as IngestCache;
  } catch {
    return null;
  }
}

async function writeCache(cache: IngestCache): Promise<void> {
  await mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}
