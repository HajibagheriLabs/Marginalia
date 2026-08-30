import { after } from "next/server";
import { z } from "zod";

import { env } from "@/lib/env";
import { enqueueIngestion } from "@/lib/ingest/enqueue";
import { PIPELINE_BUDGET_MS, runPipeline } from "@/lib/ingest/pipeline";

/**
 * THE INGESTION WORKER.
 *
 * One document, one invocation's worth of pipeline. Called by
 * `enqueueIngestion` — including by itself, when a document needs more time
 * than a single function allows. This is the consumer half of the queue seam;
 * see `enqueue.ts` for the producer half and why both are shaped this way.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * IT ANSWERS BEFORE IT WORKS, AND THAT IS THE DESIGN
 *
 * The handler authenticates, schedules the run with `after()`, and returns 202
 * immediately. The work then happens post-response, in this same invocation.
 *
 * If it instead did the work and then responded, every invocation in a chain
 * would be held open by the one that called it: a document needing five passes
 * would occupy five concurrent functions, all but one of them doing nothing but
 * waiting. Answering first makes the chain a baton pass rather than a stack.
 *
 * `after()` rather than a floating promise, because a serverless function can
 * be frozen the instant it responds — an un-awaited promise would simply stop
 * mid-batch, leaving the document parked with no error and no explanation.
 * Fluid Compute is what keeps the instance alive to finish the callback.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * AUTHENTICATION IS A SHARED SECRET, NOT A SESSION
 *
 * There is no user session on a call the server makes to itself, and this route
 * runs the most expensive work in the application. Unauthenticated, it would
 * let anyone who learned a document id spend the whole compute budget. The
 * secret is compared in constant time, and `user_id` still travels in the body
 * and is still applied as a predicate by every stage — the secret authorises
 * the invocation, it does not grant access to a document.
 */

/** Local inference needs the Node runtime; it cannot run on Edge. */
export const runtime = "nodejs";

/**
 * Ask the platform for the longest function it will give us.
 *
 * On Hobby with Fluid Compute this is ~300 s; the pipeline budgets itself well
 * inside that. Vercel reads this export at build time, so it must be a literal.
 */
export const maxDuration = 300;

const requestSchema = z.object({
  documentId: z.uuid(),
  userId: z.uuid(),
});

/** Length-independent comparison, so the secret cannot be probed by timing. */
function secretMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < provided.length; i += 1) {
    mismatch |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

export async function POST(request: Request): Promise<Response> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!secretMatches(token, env.INGEST_SECRET)) {
    // Deliberately terse. A worker endpoint owes an unauthenticated caller
    // nothing, including the knowledge that it is a worker endpoint.
    return new Response("Not found", { status: 404 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Malformed body" }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json({ error: "Malformed body" }, { status: 400 });
  }

  const { documentId, userId } = parsed.data;

  after(async () => {
    try {
      await runPipeline(documentId, userId, {
        budgetMs: PIPELINE_BUDGET_MS,
        onContinue: enqueueIngestion,
      });
    } catch (error) {
      // runPipeline records its own failures on the document. Anything landing
      // here is a failure of the orchestrator itself, which has no row to write
      // to and must at least be visible in the logs.
      console.error(`[ingest] pipeline crashed for ${documentId}`, error);
    }
  });

  return Response.json({ accepted: true, documentId }, { status: 202 });
}
