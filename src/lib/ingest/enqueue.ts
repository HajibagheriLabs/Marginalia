import { env } from "@/lib/env";

/**
 * THE QUEUE SEAM.
 *
 * "Run this document's next stage, in a fresh invocation." Today that is an
 * HTTP call to our own ingestion route; the platform's function scheduler is
 * standing in for a broker. Everything queue-shaped about the work is already
 * true — the message is `(documentId, userId)`, stages are idempotent so
 * redelivery is harmless, and all progress lives in Postgres so nothing is held
 * between deliveries.
 *
 * Replacing this with a real queue is replacing this one function: publish to
 * SQS, QStash, or a Postgres job table instead of calling fetch, and point the
 * consumer at `runPipeline`. Nothing in the four stages changes, and nothing in
 * the orchestrator changes either.
 *
 * WHY THE CALL IS NOT AWAITED FOR ITS WORK. The route answers 202 as soon as it
 * has authenticated the request and scheduled the run, so this resolves in
 * milliseconds no matter how long the document takes. If it waited for the work
 * to finish, a five-invocation document would hold every invocation in the
 * chain open at once and defeat the entire point of splitting it up.
 */

/** Where this deployment can reach itself. */
function baseUrl(): string {
  // On Vercel this is set for every deployment, including previews, and is the
  // only value that is right for the deployment actually running — a hard-coded
  // production URL would make a preview deployment drive the production one.
  const vercel = process.env.VERCEL_URL;
  if (vercel) return `https://${vercel}`;
  return env.BETTER_AUTH_URL;
}

/**
 * Ask for another invocation of the pipeline for this document.
 *
 * Failure here is logged and swallowed rather than thrown. The caller is
 * usually a stage that has just succeeded, and turning "the continuation could
 * not be scheduled" into "this stage failed" would roll a completed stage back
 * into an error state. The document simply stops where it is — mid-pipeline,
 * with its progress intact — and the next retry, whether from the UI or a
 * sweep, picks it up exactly there. Stalling is recoverable; a false failure
 * message is not.
 */
export async function enqueueIngestion(
  documentId: string,
  userId: string,
): Promise<void> {
  try {
    const response = await fetch(`${baseUrl()}/api/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.INGEST_SECRET}`,
      },
      body: JSON.stringify({ documentId, userId }),
      // Never cached, never revalidated: this is a command, not a read.
      cache: "no-store",
    });

    if (!response.ok) {
      console.error(
        `[ingest] continuation for ${documentId} was refused: ${response.status}`,
      );
    }
  } catch (error) {
    console.error(`[ingest] could not schedule continuation for ${documentId}`, error);
  }
}
