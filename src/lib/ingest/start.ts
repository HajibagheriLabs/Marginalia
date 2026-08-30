import type { DocumentStatus } from "@/db/schema";

/**
 * The single place ingestion is triggered from.
 *
 * NOT IMPLEMENTED YET, and deliberately not faked. The extraction stage lands
 * in the next step; until then a freshly uploaded document sits in `uploaded`,
 * which the rail renders as "Queued". That is the truth about its state, and
 * the state machine was designed so that being parked in a stage is a normal
 * condition rather than a broken one:
 *
 *   uploaded → extracting → chunking → embedding → indexing → ready | failed
 *
 * Every stage is idempotent and independently re-runnable, so whatever runs the
 * work later — an inline call, a cron sweep over rows stuck in `uploaded`, or a
 * real queue — picks the document up from exactly where it is. Nothing about
 * this function's callers changes when that happens; only its body does.
 *
 * Why it exists now, empty: the upload path needs ONE named seam to call, so
 * that when ingestion arrives there is no hunt for every place a document is
 * created. An empty function with a documented contract is cheaper than a
 * missing one.
 */
export async function startIngestion(documentId: string): Promise<void> {
  // Referenced so the signature is honest about what it will need, and so a
  // future implementation starts from a real argument rather than a rename.
  void documentId;
}

/** The stage a newly created document starts in. */
export const INITIAL_STATUS: DocumentStatus = "uploaded";
