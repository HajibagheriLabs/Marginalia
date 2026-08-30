import { after } from "next/server";

import type { DocumentStatus } from "@/db/schema";

import { enqueueIngestion } from "./enqueue";
import { PIPELINE_BUDGET_MS, runPipeline } from "./pipeline";

/**
 * The single place ingestion is triggered from.
 *
 *   uploaded → extracting → chunking → embedding → indexing → ready | failed
 *
 * Two callers: the upload action, once a `documents` row exists, and the retry
 * action, once a failed document has been reset to the stage it died in. Both
 * want the same thing — "start moving this document" — and neither should know
 * how many invocations that will take.
 *
 * WHY `after()` FOR THE FIRST HOP. Extraction reads the whole file and parses
 * it, which takes long enough to be felt. Running it inline would hold the
 * upload's Server Action open while a 100-page PDF is parsed, so the browser
 * would sit at "Finishing" for seconds after the bytes had already landed.
 * `after()` runs the work once the response has been sent, in the same
 * invocation — which on Fluid Compute is exactly what it is for. A plain
 * floating promise would not do: a serverless function can be frozen the moment
 * it responds, and the work would stop mid-parse.
 *
 * The first invocation therefore runs in the action's own function, and only
 * the continuations go over HTTP. That saves a round trip for the common case —
 * a small document that finishes in one pass never touches the route at all.
 *
 * The trade-off is that a failure here is not reported to the caller. It is
 * recorded on the document — `status: failed`, `failed_stage`, and a message —
 * and surfaced in the rail and the reading pane, which is where a background
 * job's failure belongs anyway.
 */
export async function startIngestion(
  documentId: string,
  userId: string,
): Promise<void> {
  after(async () => {
    try {
      await runPipeline(documentId, userId, {
        budgetMs: PIPELINE_BUDGET_MS,
        // When this invocation runs out of budget, the rest happens in fresh
        // ones. See enqueue.ts — this is the seam a real queue replaces.
        onContinue: enqueueIngestion,
      });
    } catch (error) {
      console.error(`[ingest] pipeline crashed for ${documentId}`, error);
    }
  });
}

/** The stage a newly created document starts in. */
export const INITIAL_STATUS: DocumentStatus = "uploaded";
