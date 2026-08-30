import { and, count, desc, eq, isNull } from "drizzle-orm";

import { db } from "@/db";
import { documents } from "@/db/schema";
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
}

/** This user's documents, newest first — the order the rail renders them in. */
export async function listUserDocuments(
  userId: string,
): Promise<DocumentListItemRow[]> {
  return db
    .select({
      id: documents.id,
      title: documents.title,
      pageCount: documents.pageCount,
      status: documents.status,
    })
    .from(documents)
    .where(and(eq(documents.userId, userId), isNull(documents.deletedAt)))
    .orderBy(desc(documents.createdAt));
}

/**
 * How many documents this user currently holds, for the quota check.
 *
 * Counted rather than cached: the number is small, the query is indexed on
 * (user_id, created_at), and a stale count is a quota that does not hold.
 */
export async function countUserDocuments(userId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(documents)
    .where(and(eq(documents.userId, userId), isNull(documents.deletedAt)));

  return row?.value ?? 0;
}
