import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import { chunks, documentPages, documents } from "@/db/schema";
import { getVectorStore } from "@/lib/vector";

import { chunkDocument, type PageSpan } from "./chunk";
import { PAGE_SEPARATOR } from "./extract";
import { StageError, type StageDeps, type StageResult } from "./stage";

/**
 * STAGE 2: CHUNKING.
 *
 * Reads the pages extraction wrote, rebuilds the document's concatenated text,
 * splits it into passages, and writes them. All of the interesting logic lives
 * in `chunk.ts`; this file is the part that touches the database.
 *
 *   uploaded → extracting → CHUNKING → embedding → indexing → ready | failed
 *
 * IDEMPOTENCE: delete-then-insert inside one transaction. A re-run replaces
 * this document's chunks wholesale, which also drops every `indexed_at` mark —
 * correct, because the new chunks are different rows with different text and
 * the vectors written for the old ones no longer describe anything. The
 * embedding stage will therefore redo the whole document after a re-chunk,
 * which is the right amount of work rather than a missed optimisation.
 *
 * AND IT MUST DROP THE OLD VECTORS TOO, which is less obvious and was a real
 * bug before it was tested for. Vector points are keyed by CHUNK ID, so
 * re-chunking does not overwrite them — it strands them: the new chunks get new
 * ids and new points, and the old points stay in the collection pointing at
 * chunk ids that no longer exist. Nothing complains. A search then returns hits
 * that resolve to no row and get dropped on the way out, so the document
 * quietly retrieves fewer passages than the caller asked for, and the ones it
 * loses are chosen by whichever stale vector happened to rank well.
 *
 * The vectors are therefore deleted BEFORE the rows are replaced, not after.
 * Should the transaction then fail, the document is left with chunks marked
 * indexed but no vectors behind them — a state the indexing stage's count check
 * catches and turns into a failed document with a retry, which is recoverable.
 * The other order fails silently: new points written alongside old orphans,
 * with a total that no check can distinguish from correct.
 *
 * FAST: pure CPU over text already in Postgres, with no model and no network.
 * Even a 900-page document chunks in a couple of seconds, so unlike embedding
 * this stage does not need to resume partway and always returns complete.
 */

/**
 * Rebuild the exact text that page offsets index into.
 *
 * `assemblePages` joined the page texts with `PAGE_SEPARATOR`, so joining them
 * the same way reproduces the concatenation byte for byte. That is an assumption
 * worth checking rather than trusting: every downstream offset — chunk
 * boundaries, citation ranges, the viewer's highlight — is measured against this
 * string, and a silent one-character drift would put every highlight in the
 * document slightly in the wrong place.
 *
 * So the invariant extraction promises is re-asserted here, at the one point
 * where the text is reconstructed rather than produced.
 */
function rebuildDocumentText(
  pages: Array<{ pageNumber: number; text: string; charStart: number; charEnd: number }>,
): string {
  const text = pages.map((page) => page.text).join(PAGE_SEPARATOR);

  for (const page of pages) {
    if (text.slice(page.charStart, page.charEnd) !== page.text) {
      throw new StageError(
        "This document's stored text no longer lines up with its pages. " +
          "Re-upload it to rebuild the index.",
      );
    }
  }

  return text;
}

export async function runChunking(
  documentId: string,
  userId: string,
  deps?: StageDeps,
): Promise<StageResult> {
  const [document] = await db
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.userId, userId),
        isNull(documents.deletedAt),
      ),
    )
    .limit(1);

  if (!document) {
    throw new StageError("That document no longer exists.");
  }

  const pages = await db
    .select({
      pageNumber: documentPages.pageNumber,
      text: documentPages.text,
      charStart: documentPages.charStart,
      charEnd: documentPages.charEnd,
    })
    .from(documentPages)
    .where(eq(documentPages.documentId, document.id))
    .orderBy(asc(documentPages.pageNumber));

  if (pages.length === 0) {
    // Extraction is supposed to have run first. Reaching here means the row
    // advanced without its pages — a bug in the orchestrator or a partially
    // rolled back transaction, not a bad document.
    throw new StageError(
      "This document has no extracted text to split. Retry from the beginning.",
    );
  }

  const text = rebuildDocumentText(pages);
  const spans: PageSpan[] = pages.map((page) => ({
    pageNumber: page.pageNumber,
    charStart: page.charStart,
    charEnd: page.charEnd,
  }));

  const produced = chunkDocument({ text, pages: spans });

  if (produced.length === 0) {
    throw new StageError(
      "No readable passages could be found in this document.",
    );
  }

  const tokenCount = produced.reduce((sum, chunk) => sum + chunk.tokenCount, 0);

  // Only when there is something to strand. On a first ingest there are no
  // chunks and no points, so this stage stays pure Postgres and never touches
  // the vector store at all — which is the common path.
  const [{ existing }] = await db
    .select({ existing: sql<number>`count(*)::int` })
    .from(chunks)
    .where(eq(chunks.documentId, document.id));

  if (existing > 0) {
    const store = deps?.vectors ?? getVectorStore();
    try {
      // The collection may legitimately not exist yet if a previous run failed
      // before embedding; ensuring it makes the delete well-defined either way.
      await store.ensureCollection();
      await store.deleteByDocument(document.id);
    } catch (error) {
      throw new StageError(
        "The old search index entries for this document could not be cleared. Try again in a moment.",
        { cause: error },
      );
    }
  }

  await db.transaction(async (tx) => {
    // IDEMPOTENCE. Chunk rows are derived data with no identity of their own —
    // there is nothing to preserve across a re-chunk, and matching old rows to
    // new ones would be guesswork. Replacing them is both simpler and correct.
    await tx.delete(chunks).where(eq(chunks.documentId, document.id));

    await tx.insert(chunks).values(
      produced.map((chunk) => ({
        documentId: document.id,
        ordinal: chunk.ordinal,
        text: chunk.text,
        tokenCount: chunk.tokenCount,
        pageFrom: chunk.pageFrom,
        pageTo: chunk.pageTo,
        charStart: chunk.charStart,
        charEnd: chunk.charEnd,
        sectionPath: chunk.sectionPath,
        // embedding_model and indexed_at stay null: this chunk exists but has
        // not been embedded yet, and the embedding stage selects on exactly
        // that.
      })),
    );

    await tx
      .update(documents)
      .set({ chunkCount: produced.length, tokenCount })
      .where(eq(documents.id, document.id));
  });

  return {
    complete: true,
    detail: `${produced.length} passages, ${tokenCount} tokens`,
  };
}
