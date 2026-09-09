import { after } from "next/server";

import type { DocumentStatus } from "@/db/schema";

import { enqueueIngestion } from "./enqueue";

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
 * ───────────────────────────────────────────────────────────────────────────
 * EVERY PASS RUNS IN THE INGESTION ROUTE, INCLUDING THE FIRST.
 *
 * This used to run the first pass INLINE, in the calling Server Action's own
 * function via `after()`, so that a small document finishing in one pass never
 * paid for an HTTP round trip. That was a good optimisation and it is gone for
 * a concrete deployment reason.
 *
 * The embedding stage needs ONNX Runtime, whose shared library has to be named
 * explicitly in `outputFileTracingIncludes` — the file tracer cannot see it,
 * because the native addon `dlopen`s it and no JavaScript ever references it.
 * Naming it for the two API routes works. Naming it for the app routes as well,
 * which is what running inline required, made the Vercel build compile and then
 * fail while deploying its outputs.
 *
 * So the native stack now lives in exactly two functions — `/api/chat` and
 * `/api/ingest` — and everything else stays free of it. What that buys, beyond
 * a deploy that works: the page functions no longer carry 34 MB of binaries
 * they never execute, and there is one place where inference happens rather
 * than two.
 *
 * WHAT IT COSTS: one HTTP round trip before a document starts moving. The route
 * answers 202 as soon as it has authenticated and scheduled the run, so this is
 * milliseconds, and it is paid once per document rather than per pass.
 *
 * `after()` still wraps the call so the upload response is not held open by it,
 * and a failure to schedule is logged rather than thrown — the document simply
 * stays in `uploaded` with its "Retry" action intact. Stalling is recoverable;
 * turning a successful upload into an error is not.
 */
export async function startIngestion(
  documentId: string,
  userId: string,
): Promise<void> {
  after(async () => {
    await enqueueIngestion(documentId, userId);
  });
}

/** The stage a newly created document starts in. */
export const INITIAL_STATUS: DocumentStatus = "uploaded";
