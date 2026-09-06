import { eq } from "drizzle-orm";

import { db } from "@/db";
import { documentPages, documents } from "@/db/schema";

import { runChunking } from "./chunk-stage";
import { runEmbedding } from "./embed-stage";
import { assemblePages, paginateText } from "./extract";
import { runIndexing } from "./index-stage";
import type { StageDeps } from "./stage";

/**
 * INGEST A DOCUMENT WE ALREADY HAVE THE TEXT OF.
 *
 * Two callers, one path: the eval harness (evals/src/corpus.ts) and the demo
 * seed (scripts/seed.ts). Both start from committed plain text in
 * evals/dataset/ rather than from a file somebody uploaded, and both need the
 * result to be a genuine document — real chunks, real vectors, retrievable by
 * the real `retrieve()` — rather than a fixture.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT THE `extracting` STAGE
 *
 * Because `runExtraction` downloads a blob and parses a PDF or DOCX, and there
 * is no blob: the bytes are in the repository. So this substitutes the two
 * pure functions that stage would have called — `paginateText` to split into
 * synthesized blocks and `assemblePages` to compute each block's span — and
 * writes the same `document_pages` rows.
 *
 * `assemblePages` is the ONLY place offsets are derived anywhere in the
 * codebase, which is what makes that substitution safe: a citation resolved
 * against a seeded document lands on exactly the characters it would land on
 * for an uploaded one.
 *
 * Everything after that IS the shipping pipeline. Chunking, embedding, and
 * indexing are the same three stage functions the orchestrator calls, in the
 * same order, with the same idempotence. What this skips is file parsing; what
 * it does not skip is anything retrieval depends on.
 */

export interface SeedTextDocument {
  /** Shown in the library rail and prepended to every chunk as context. */
  title: string;
  /** The stored filename. Also how a re-seed recognises an existing document. */
  filename: string;
  text: string;
}

export interface SeedTextResult {
  documentId: string;
  pages: number;
  chunks: number;
  /** One line per stage, for the seed script's log. */
  detail: string[];
}

/**
 * Ingest one document end to end, replacing any previous copy.
 *
 * `deps.vectors` selects the collection, so the eval can point at its own and
 * the seed at the production one. `deps.chunkOptions` is how a chunk-size
 * sweep re-ingests under a different budget.
 *
 * The embedding stage yields when its time budget runs out — in production the
 * orchestrator re-invokes it over HTTP — so it is simply called again here
 * until it reports complete. `deps.deadline` is generous by default because
 * this runs on a workstation, not in a 300-second function.
 */
export async function ingestTextDocument(
  input: SeedTextDocument & { userId: string; deps: StageDeps },
): Promise<SeedTextResult> {
  const { userId, title, filename, text, deps } = input;
  const detail: string[] = [];

  const { pages } = assemblePages(paginateText(text));

  const [row] = await db
    .insert(documents)
    .values({
      userId,
      title,
      filename,
      mimeType: "text/plain",
      byteSize: Buffer.byteLength(text, "utf8"),
      /*
       * A DELIBERATELY NON-RESOLVING BLOB URL.
       *
       * Nothing fetches it: extraction is the only stage that reads a blob and
       * it does not run here. Recording a plausible-looking URL would be worse
       * than recording an impossible one — a future caller that did try to
       * fetch it would silently hit somebody else's storage instead of failing.
       * `.invalid` is reserved by RFC 2606 and never resolves.
       */
      blobUrl: `https://seed.invalid/${filename}`,
      blobPathname: `seed/${filename}`,
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
  detail.push(`${pages.length} blocks`);

  const chunked = await runChunking(row.id, userId, deps);
  if (chunked.detail) detail.push(chunked.detail);

  for (let pass = 0; ; pass += 1) {
    const result = await runEmbedding(row.id, userId, deps);
    if (result.detail) detail.push(result.detail);
    if (result.complete) break;
    if (pass > 50) {
      throw new Error(`${filename}: embedding is not converging after ${pass} passes`);
    }
  }

  await runIndexing(row.id, userId, deps);

  // `ready` is the orchestrator's job in production, and this function is
  // standing in for the orchestrator. Written last, after indexing has verified
  // that the vector store holds what the embedding stage believes it wrote.
  await db
    .update(documents)
    .set({ status: "ready", readyAt: new Date() })
    .where(eq(documents.id, row.id));

  const [counts] = await db
    .select({ chunkCount: documents.chunkCount })
    .from(documents)
    .where(eq(documents.id, row.id));

  return {
    documentId: row.id,
    pages: pages.length,
    chunks: counts?.chunkCount ?? 0,
    detail,
  };
}
