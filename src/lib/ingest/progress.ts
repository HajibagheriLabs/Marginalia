import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import { chunks, documents, type DocumentStatus } from "@/db/schema";

import type { ProgressSnapshot } from "./progress-format";

/**
 * What the UI needs to say something true about a document in flight.
 *
 * The design rule this exists to serve: "Embedding 240 of 612 passages", not a
 * spinner. A spinner says the page is not frozen. It does not say whether the
 * document is nearly done or has barely started, whether it is moving at all,
 * or whether it is worth waiting for — which is the entire question a person
 * has while watching an upload process.
 *
 * Every number here is DERIVED FROM THE WORK, never from a progress field
 * written alongside it. `done` is a count of chunks with `indexed_at` set,
 * which is the same predicate the embedding stage uses to decide what is left.
 * A separate counter could drift from reality — the classic progress bar that
 * sits at 100% while nothing is finished — and this one cannot, because it is
 * reading the work itself.
 */

/**
 * The wording lives in `progress-format.ts`, which has no server imports, and
 * is re-exported here so server code can reach both halves through one module.
 */
export {
  describeProgress,
  progressPercent,
  type ProgressSnapshot,
} from "./progress-format";

export interface DocumentProgress extends ProgressSnapshot {
  id: string;
  failedStage: DocumentStatus | null;
  errorMessage: string | null;
  /** True once the document stops moving on its own. */
  terminal: boolean;
}

export async function readDocumentProgress(
  documentId: string,
  userId: string,
): Promise<DocumentProgress | null> {
  const [document] = await db
    .select({
      id: documents.id,
      status: documents.status,
      failedStage: documents.failedStage,
      errorMessage: documents.errorMessage,
      pageCount: documents.pageCount,
      chunkCount: documents.chunkCount,
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

  if (!document) return null;

  // Only counted while it can change. A ready document's answer is
  // `chunkCount`, and a query per poll per ready document is a query for
  // nothing.
  let indexedCount = 0;
  if (document.status === "embedding" || document.status === "indexing") {
    const [row] = await db
      .select({ value: sql<number>`count(${chunks.indexedAt})::int` })
      .from(chunks)
      .where(eq(chunks.documentId, document.id));
    indexedCount = row?.value ?? 0;
  } else if (document.status === "ready") {
    indexedCount = document.chunkCount ?? 0;
  }

  return {
    ...document,
    indexedCount,
    terminal: document.status === "ready" || document.status === "failed",
  };
}
