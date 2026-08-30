import type { DocumentStatus } from "@/db/schema";

/**
 * How ingestion progress is WORDED. No database, no server imports, nothing
 * but arithmetic on numbers the caller already has.
 *
 * Split from `progress.ts` for the same reason `env.public.ts` is split from
 * `env.ts`: that module reads Postgres, so importing one function from it drags
 * the whole driver behind it. The rail's row is a Client Component, and a
 * client bundle that pulls in `postgres` does not merely bloat — it fails the
 * build outright, which is how this file came to exist.
 *
 * `DocumentStatus` is a type-only import and erases at compile time, so it
 * carries nothing into the bundle.
 */

/** Everything needed to describe a document's progress, and nothing more. */
export interface ProgressSnapshot {
  status: DocumentStatus;
  pageCount: number | null;
  /** Total passages, once chunking has run. */
  chunkCount: number | null;
  /** Passages already embedded and stored. */
  indexedCount: number;
}

/**
 * The sentence shown wherever a document is being processed.
 *
 * Written to the project's UI rules: plain verbs, sentence case, no filler, and
 * a real number wherever one exists. The counts appear only once they mean
 * something — "Embedding 0 of 0 passages" during extraction would be worse than
 * saying nothing, because it invents a denominator the pipeline has not
 * computed yet.
 *
 * One function, used by both the rail row and the reading pane, so the two can
 * never disagree about what a document is doing.
 */
export function describeProgress(progress: ProgressSnapshot): string {
  const { status, pageCount, chunkCount, indexedCount } = progress;

  switch (status) {
    case "uploaded":
      return "Queued";
    case "extracting":
      return "Extracting text";
    case "chunking":
      return pageCount
        ? `Splitting ${pageCount} ${pageCount === 1 ? "page" : "pages"} into passages`
        : "Splitting into passages";
    case "embedding":
      return chunkCount
        ? `Embedding ${indexedCount} of ${chunkCount} passages`
        : "Embedding passages";
    case "indexing":
      return chunkCount
        ? `Indexing ${chunkCount} passages`
        : "Indexing passages";
    case "ready":
      return "Ready";
    case "failed":
      return "Failed";
  }
}

/**
 * How far along, 0–100, or null when there is nothing honest to show.
 *
 * Null during extraction and chunking on purpose. Those stages have no
 * countable unit — extraction is one indivisible parse — and a bar that moves
 * on a timer rather than on progress is a lie told in a very reassuring way.
 * The stage name alone is the honest readout there.
 */
export function progressPercent(
  progress: Pick<ProgressSnapshot, "status" | "chunkCount" | "indexedCount">,
): number | null {
  if (progress.status === "ready") return 100;
  if (progress.status !== "embedding") return null;
  if (!progress.chunkCount) return null;
  return Math.round((progress.indexedCount / progress.chunkCount) * 100);
}
