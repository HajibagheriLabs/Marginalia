import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/db";
import { documents, type DocumentStatus } from "@/db/schema";

import { runChunking } from "./chunk-stage";
import { runEmbedding } from "./embed-stage";
import { runExtraction } from "./extract-stage";
import { runIndexing } from "./index-stage";
import {
  StageError,
  type StageDeps,
  type StageName,
  type StageRunner,
} from "./stage";

/**
 * THE ORCHESTRATOR.
 *
 * Owns the state machine and nothing else. It decides which stage runs next,
 * claims it, runs it, and advances or fails the document. The stages themselves
 * know none of this — see the contract in `stage.ts`.
 *
 *   uploaded → extracting → chunking → embedding → indexing → ready
 *                   ↓          ↓           ↓          ↓
 *                 failed (failed_stage records which one, so a retry resumes
 *                         from there rather than from the beginning)
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE STATUS COLUMN MEANS "WHAT HAPPENS NEXT", NOT "WHAT FINISHED"
 *
 * `documents.status` names the stage that is pending or running. `chunking`
 * means extraction is done and chunking has not finished. That is why a
 * document parks in a stage rather than between stages, and why resuming is
 * just "run the stage the status names" — there is no separate cursor to keep
 * in step with the row, and no state that exists only in the orchestrator's
 * memory.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A LOOP AND NOT A QUEUE, AND HOW TO MAKE IT ONE
 *
 * A queue is the right answer for this shape of work and this is deliberately
 * not one, because a queue on a free tier means another hosted service. What
 * replaces it is a loop that runs stages until it approaches the function's
 * time limit, then asks to be invoked again — the platform's own retry surface
 * standing in for a broker.
 *
 * The seam is `onContinue`. Everything queue-shaped is already true: stages are
 * idempotent, so redelivery is safe; progress is in the database, so nothing is
 * lost between invocations; and the unit of work is (documentId, stage), which
 * is exactly what a message would carry. Swapping in a real queue means
 * replacing the callback that re-invokes the route with one that enqueues a
 * message, and changing nothing in this file's logic and nothing at all in the
 * four stages.
 */

interface PipelineStep {
  stage: StageName;
  run: StageRunner;
  /** Where the document goes when this stage reports complete. */
  next: DocumentStatus;
}

/**
 * The pipeline, in order. Adding a stage is adding a row here plus a runner.
 */
const PIPELINE: PipelineStep[] = [
  { stage: "extracting", run: runExtraction, next: "chunking" },
  { stage: "chunking", run: runChunking, next: "embedding" },
  { stage: "embedding", run: runEmbedding, next: "indexing" },
  { stage: "indexing", run: runIndexing, next: "ready" },
];

/**
 * Which step a status maps to. `uploaded` is the entry point and runs
 * extraction; every other non-terminal status names its own stage.
 */
function stepFor(status: DocumentStatus): PipelineStep | null {
  if (status === "uploaded") return PIPELINE[0];
  return PIPELINE.find((step) => step.stage === status) ?? null;
}

/**
 * How long one invocation of the whole pipeline may run.
 *
 * Vercel Hobby with Fluid Compute allows roughly 300 s. This leaves a wide
 * margin: the deadline is only checked BETWEEN units of work, and the longest
 * indivisible unit is one batch of 32 passages plus, on a cold instance, a
 * model load that can take 30 s on its own. Running to 300 s and hoping would
 * turn a slow batch into a killed function, which loses the log line explaining
 * what happened — the one thing needed to debug it.
 */
export const PIPELINE_BUDGET_MS = 200_000;

/** Leave this much of the budget unspent, so a final stage can finish cleanly. */
const RESERVE_MS = 30_000;

export interface PipelineOptions extends StageDeps {
  /** Overrides `PIPELINE_BUDGET_MS`. */
  budgetMs?: number;
  /**
   * Called when the document still has work but this invocation is out of
   * time. THE QUEUE SEAM — see the header. Production re-invokes the ingest
   * route; a test passes nothing and drives the loop itself.
   */
  onContinue?: (documentId: string, userId: string) => Promise<void> | void;
}

export interface PipelineOutcome {
  status: DocumentStatus;
  /** Stages that ran to completion in THIS invocation. */
  ran: StageName[];
  /** True when the document reached a terminal state. */
  finished: boolean;
  error?: string;
}

/**
 * Advance one document as far as this invocation's budget allows.
 *
 * Safe to call on a document in any state, including one already `ready` — it
 * returns immediately. That matters because it is called from three places
 * that cannot coordinate: the upload action, the retry action, and the
 * pipeline re-invoking itself.
 */
export async function runPipeline(
  documentId: string,
  userId: string,
  options: PipelineOptions = {},
): Promise<PipelineOutcome> {
  const budgetMs = options.budgetMs ?? PIPELINE_BUDGET_MS;
  const startedAt = Date.now();
  const hardDeadline = startedAt + budgetMs;
  const ran: StageName[] = [];

  for (;;) {
    const document = await loadState(documentId, userId);
    if (!document) {
      // Deleted mid-flight. Not an error: the user's intent is clear and there
      // is no row left to record a failure on.
      return { status: "failed", ran, finished: true, error: "deleted" };
    }

    if (document.status === "ready" || document.status === "failed") {
      return { status: document.status, ran, finished: true };
    }

    const step = stepFor(document.status);
    if (!step) {
      return { status: document.status, ran, finished: true };
    }

    // Out of time before starting the next stage: hand back and ask to be
    // called again. The document keeps its status, so the next invocation picks
    // up exactly here.
    if (Date.now() >= hardDeadline - RESERVE_MS && ran.length > 0) {
      await options.onContinue?.(documentId, userId);
      return { status: document.status, ran, finished: false };
    }

    // CLAIM the stage before doing any work, so the rail shows "Embedding" for
    // the whole time it runs rather than only once it succeeds.
    if (document.status !== step.stage) {
      await db
        .update(documents)
        .set({ status: step.stage, failedStage: null, errorMessage: null })
        .where(eq(documents.id, documentId));
    }

    const stageStartedAt = Date.now();
    let result;
    try {
      result = await step.run(documentId, userId, {
        embeddings: options.embeddings,
        vectors: options.vectors,
        deadline: hardDeadline - RESERVE_MS,
      });
    } catch (error) {
      const message = await failDocument(documentId, step.stage, error);
      return { status: "failed", ran, finished: true, error: message };
    }

    console.info(
      `[ingest] ${documentId} ${step.stage} ${
        result.complete ? "complete" : "partial"
      } in ${Date.now() - stageStartedAt}ms${result.detail ? ` — ${result.detail}` : ""}`,
    );

    if (!result.complete) {
      // The stage has more to do. Keep the status where it is and come back.
      await options.onContinue?.(documentId, userId);
      return { status: step.stage, ran, finished: false };
    }

    ran.push(step.stage);

    await db
      .update(documents)
      .set({ status: step.next, failedStage: null, errorMessage: null })
      .where(eq(documents.id, documentId));

    if (step.next === "ready") {
      return { status: "ready", ran, finished: true };
    }
  }
}

async function loadState(documentId: string, userId: string) {
  const [row] = await db
    .select({ status: documents.status })
    .from(documents)
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.userId, userId),
        isNull(documents.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Record a failure so that a retry can resume from exactly here.
 *
 * Three things are written and everything else is LEFT ALONE. `failed_stage` is
 * what the retry reads to know where to restart; the message is what the user
 * reads. The pages, chunks, and vector points already produced stay exactly as
 * they are — that is what makes a retry resume rather than restart, and it is
 * safe precisely because every stage is idempotent.
 *
 * A `StageError` carries a message written for the person who uploaded the
 * file. Anything else is a bug: its text could name a table, a connection
 * string, or a stack frame, so it is logged and replaced.
 */
async function failDocument(
  documentId: string,
  stage: StageName,
  error: unknown,
): Promise<string> {
  const known = error instanceof StageError;
  const message = known
    ? error.message
    : "This document could not be processed. Try again, or re-upload it.";

  if (!known) {
    console.error(`[ingest] ${documentId} ${stage} unexpected failure`, error);
  } else {
    console.warn(`[ingest] ${documentId} ${stage} failed — ${error.message}`);
  }

  await db
    .update(documents)
    .set({ status: "failed", failedStage: stage, errorMessage: message })
    .where(eq(documents.id, documentId));

  return message;
}

/**
 * Put a failed document back on the pipeline at the stage it died in.
 *
 * Resuming rather than restarting is the whole point of recording
 * `failed_stage`: a 200-page PDF that failed while embedding passage 400 has
 * already been downloaded, parsed, and chunked, and none of that work needs
 * doing again. Setting the status back to the failed stage is all it takes,
 * because the status IS the cursor.
 *
 * A document with no `failed_stage` — failed before any stage was claimed, or
 * from an older row — restarts from the top, which is always safe.
 */
export async function resumeFailedDocument(
  documentId: string,
  userId: string,
): Promise<DocumentStatus> {
  const [document] = await db
    .select({
      status: documents.status,
      failedStage: documents.failedStage,
    })
    .from(documents)
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.userId, userId),
        isNull(documents.deletedAt),
      ),
    )
    .limit(1);

  if (!document) throw new StageError("That document no longer exists.");

  const resumeAt: DocumentStatus =
    document.status === "failed" ? (document.failedStage ?? "uploaded") : document.status;

  await db
    .update(documents)
    .set({ status: resumeAt, failedStage: null, errorMessage: null })
    .where(eq(documents.id, documentId));

  return resumeAt;
}
