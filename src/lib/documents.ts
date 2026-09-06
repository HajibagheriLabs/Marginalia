import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import { chunks, documents } from "@/db/schema";
import type { DocumentStatus } from "@/db/schema";

/**
 * Reads over the `documents` table.
 *
 * Every function here takes a `userId` and applies it as a predicate. There is
 * no "get all documents" — the ownership filter is not an argument a caller can
 * forget, because there is no overload without it. Single-document reads go
 * through `requireDocumentAccess` in src/lib/auth-server.ts, which returns the
 * row and proves ownership in one call.
 *
 * `deleted_at IS NULL` is part of every query. `documents` is the only
 * soft-deleted table in the schema, and a deleted document must be invisible to
 * the rail, to the quota, and to retrieval alike.
 */

/** What the library rail needs, and nothing else. */
export interface DocumentListItemRow {
  id: string;
  title: string;
  pageCount: number | null;
  status: DocumentStatus;
  /** Total passages, once chunking has run. */
  chunkCount: number | null;
  /** Passages already embedded. Only counted for documents still embedding. */
  indexedCount: number;
}

/**
 * This user's documents, newest first — the order the rail renders them in.
 *
 * The indexed-passage count is fetched in a SECOND query rather than as a join,
 * and only for the documents that are actually mid-embedding. The rail is
 * rendered on every navigation for every user, and a `LEFT JOIN ... GROUP BY`
 * against the chunks table would make every one of those renders aggregate over
 * every chunk the user owns — tens of thousands of rows — to put a number next
 * to the one document that is currently moving. Most of the time the list below
 * is empty and the second query never runs at all.
 */
export async function listUserDocuments(
  userId: string,
): Promise<DocumentListItemRow[]> {
  const rows = await db
    .select({
      id: documents.id,
      title: documents.title,
      pageCount: documents.pageCount,
      status: documents.status,
      chunkCount: documents.chunkCount,
    })
    .from(documents)
    .where(and(eq(documents.userId, userId), isNull(documents.deletedAt)))
    .orderBy(desc(documents.createdAt));

  const inFlight = rows
    .filter((row) => row.status === "embedding" || row.status === "indexing")
    .map((row) => row.id);

  const indexed = new Map<string, number>();
  if (inFlight.length > 0) {
    const counts = await db
      .select({
        documentId: chunks.documentId,
        value: sql<number>`count(${chunks.indexedAt})::int`,
      })
      .from(chunks)
      .where(inArray(chunks.documentId, inFlight))
      .groupBy(chunks.documentId);

    for (const row of counts) indexed.set(row.documentId, row.value);
  }

  return rows.map((row) => ({
    ...row,
    indexedCount:
      row.status === "ready"
        ? (row.chunkCount ?? 0)
        : (indexed.get(row.id) ?? 0),
  }));
}

/**
 * The document count lives in src/lib/usage/guard.ts, next to the transaction
 * that enforces the limit it feeds. Counting in one file and enforcing in
 * another is how a quota check drifts out of step with the write it guards.
 */
export { countUserDocuments } from "@/lib/usage/guard";
