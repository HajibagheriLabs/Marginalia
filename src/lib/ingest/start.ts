import { after } from "next/server";

import type { DocumentStatus } from "@/db/schema";

import { runExtraction } from "./extract-stage";

/**
 * The single place ingestion is triggered from.
 *
 * The state machine is:
 *
 *   uploaded → extracting → chunking → embedding → indexing → ready | failed
 *
 * Extraction is implemented. The stages after it are not yet, so a document
 * currently walks as far as `chunking` and parks there. Every stage is
 * idempotent and independently re-runnable, so whatever runs the rest later —
 * a cron sweep over rows stuck mid-pipeline, or a real queue — picks each
 * document up exactly where it stopped.
 *
 * WHY `after()`: extraction reads the whole file and parses it, which takes
 * long enough to be felt. Running it inline would hold the upload's Server
 * Action open while a 100-page PDF is parsed, so the browser would sit at
 * "Finishing" for seconds after the bytes had already landed. `after()` runs
 * the work once the response has been sent, in the same invocation — which on
 * Vercel's Fluid Compute is exactly what it is for. A plain floating promise
 * would not do: a serverless function can be frozen the moment it responds, and
 * the work would simply stop mid-parse.
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
    await runExtraction(documentId, userId);
  });
}

/** The stage a newly created document starts in. */
export const INITIAL_STATUS: DocumentStatus = "uploaded";
