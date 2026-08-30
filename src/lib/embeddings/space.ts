import { and, eq, inArray, isNull } from "drizzle-orm";

import { db } from "@/db";
import { documents } from "@/db/schema";

import { getEmbeddingProvider } from "./provider";
import type { EmbeddingSpace } from "./types";

/**
 * NEVER MIX EMBEDDING SPACES.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 *
 * A vector only means something relative to the model that produced it. Two
 * models embed "termination for convenience" into two different 384-dimensional
 * spaces, and the cosine between one model's query vector and another model's
 * passage vector is not a weak signal or a noisy signal — it is not a signal.
 * The axes do not correspond.
 *
 * What makes this dangerous rather than merely wrong is HOW IT FAILS. Nothing
 * throws. The dimensions match, so Qdrant accepts the query and returns
 * results. The results are ranked, they have plausible scores between 0 and 1,
 * and they are rendered in the UI with citations attached. They are simply the
 * wrong passages, and the only way to find out is to read the answers and
 * notice they are subtly bad. A search that mixes spaces produces a confident,
 * well-cited, incorrect application.
 *
 * That is the worst failure mode available to this codebase, so it is checked
 * explicitly, before the search, rather than trusted to discipline.
 *
 * HOW A MIX HAPPENS. Nobody sets out to do it. It happens when
 * EMBEDDING_MODEL is edited in the environment while documents already exist:
 * every document ingested before the change is in the old space, everything
 * after is in the new one, and the library rail shows them side by side with
 * no visible difference. Selecting one of each into a conversation is then a
 * completely ordinary thing for a user to do.
 *
 * THE FIX IS NEVER A CODE CHANGE. Changing the embedding model means
 * re-ingesting every document — new vectors, new collection. There is no
 * migration, because there is no function from one space to the other.
 * ───────────────────────────────────────────────────────────────────────────
 */

export class EmbeddingSpaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingSpaceError";
  }
}

/** Two spaces match only if BOTH the model and the dimension agree. */
export function sameSpace(a: EmbeddingSpace, b: EmbeddingSpace): boolean {
  return a.model === b.model && a.dimensions === b.dimensions;
}

/**
 * Refuse a search whose documents were not all embedded by the active model.
 *
 * Call this BEFORE embedding the query and before touching the vector store,
 * on every path that searches more than one document — and on single-document
 * paths too, since a single stale document is just as wrong, only quieter.
 *
 * WHY `userId` IS REQUIRED even though document ids are unique: `documents` is
 * a user-owned table, and the project rule that every query against one carries
 * a user_id predicate has no exception for code that happens to trust itself.
 * It also makes this function a genuine ownership check — a caller that passes
 * another user's document id gets "not found", not that user's metadata.
 *
 * Returns the space on success, so the caller can pass it straight to the
 * vector store rather than re-deriving it.
 */
export async function assertSameEmbeddingSpace(
  documentIds: string[],
  userId: string,
): Promise<EmbeddingSpace> {
  const active = getEmbeddingProvider();
  const wanted: EmbeddingSpace = {
    model: active.model,
    dimensions: active.dimensions,
  };

  if (documentIds.length === 0) {
    throw new EmbeddingSpaceError(
      "No documents were selected for this search.",
    );
  }

  const unique = [...new Set(documentIds)];

  const rows = await db
    .select({
      id: documents.id,
      title: documents.title,
      model: documents.embeddingModel,
      dimensions: documents.embeddingDim,
    })
    .from(documents)
    .where(
      and(
        inArray(documents.id, unique),
        eq(documents.userId, userId),
        isNull(documents.deletedAt),
      ),
    );

  if (rows.length !== unique.length) {
    // Covers both "deleted" and "belongs to someone else" — deliberately the
    // same message, so this cannot be used to probe for another user's ids.
    throw new EmbeddingSpaceError(
      "Some of the selected documents are no longer available. Refresh and try again.",
    );
  }

  const unembedded = rows.filter((row) => !row.model || !row.dimensions);
  if (unembedded.length > 0) {
    throw new EmbeddingSpaceError(
      `${quoteTitles(unembedded)} ${unembedded.length === 1 ? "has" : "have"} ` +
        "not finished processing yet. Wait for indexing to finish, then ask again.",
    );
  }

  const mismatched = rows.filter(
    (row) =>
      !sameSpace(
        { model: row.model!, dimensions: row.dimensions! },
        wanted,
      ),
  );

  if (mismatched.length > 0) {
    const found = [
      ...new Set(mismatched.map((row) => `${row.model} (${row.dimensions}d)`)),
    ];
    throw new EmbeddingSpaceError(
      `${quoteTitles(mismatched)} ${mismatched.length === 1 ? "was" : "were"} ` +
        `indexed with ${found.join(", ")}, but this workspace now searches ` +
        `with ${wanted.model} (${wanted.dimensions}d). Vectors from different ` +
        "models cannot be compared. Re-upload these documents to search them.",
    );
  }

  return wanted;
}

/** At most three titles, so an error about forty documents is still readable. */
function quoteTitles(rows: Array<{ title: string }>): string {
  const shown = rows.slice(0, 3).map((row) => `"${row.title}"`);
  const rest = rows.length - shown.length;
  return rest > 0
    ? `${shown.join(", ")} and ${rest} other${rest === 1 ? "" : "s"}`
    : shown.join(" and ");
}
