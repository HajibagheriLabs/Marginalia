import { db } from "@/db";
import { usageEvents } from "@/db/schema";

import { completionCostCents } from "./pricing";

/**
 * THE METER. Every unit of work this app does, written to `usage_events`.
 *
 * Two kinds are recorded, and they are recorded for different reasons:
 *
 *   embedding   — one row per batch, `source: "local"`. Nothing is billed;
 *                 what is real is the token count and the wall-clock
 *                 milliseconds, which is the cost that would turn into money
 *                 first if this ever left the free tier.
 *   completion  — one row per answer, `source` set to the model that ACTUALLY
 *                 served it after failover. Cost comes from the price table in
 *                 ./pricing.ts, so it is a lookup rather than a literal zero
 *                 typed at the call site.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * METERING NEVER FAILS THE WORK IT MEASURES.
 *
 * Every writer here swallows its own errors and logs them. Losing a usage row
 * is a gap in a readout; failing an ingestion or an answer because bookkeeping
 * failed is a gap in the product. The asymmetry is deliberate and it is the
 * reason none of these functions return a value the caller has to check.
 */

/**
 * One embedding batch, computed locally.
 *
 * `source` is the literal "local", not the model slug — that is the contract
 * `usage_events.source` documents: WHO did the work, where the answer is
 * either "this process" or the vendor that billed for it. The slug belongs to
 * `documents.embedding_model`, which is the column that has to be right for
 * the embedding-space guard, and duplicating it here would give two places to
 * disagree about which model a document was embedded with.
 */
export async function recordEmbeddingUsage(input: {
  userId: string;
  tokens: number;
  durationMs: number;
}): Promise<void> {
  try {
    await db.insert(usageEvents).values({
      userId: input.userId,
      kind: "embedding",
      quantity: input.tokens,
      // Zero because nothing metered it, not because it was too small to
      // record — `source` is what makes that legible.
      costCents: 0,
      source: "local",
      durationMs: input.durationMs,
    });
  } catch (error) {
    console.error("[usage] failed to record embedding batch", error);
  }
}

/**
 * One completion.
 *
 * `quantity` is prompt + completion tokens, because the settings summary
 * reports tokens rather than a dollar figure and a single number is what it
 * shows. The split survives on the `messages` row, which is where a per-answer
 * readout reads it from.
 */
export async function recordCompletionUsage(input: {
  userId: string;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
}): Promise<void> {
  const tokens = (input.promptTokens ?? 0) + (input.completionTokens ?? 0);

  try {
    await db.insert(usageEvents).values({
      userId: input.userId,
      kind: "completion",
      quantity: tokens,
      // From the table. Null means "this model has no price on file", which is
      // unreachable while env.ts holds the `:free` rule — and is recorded as 0
      // with the model named in `source` rather than left blank, so a future
      // paid slug shows up as a real number instead of a hole.
      costCents: completionCostCents(input) ?? 0,
      source: input.model,
      durationMs: input.latencyMs,
    });
  } catch (error) {
    console.error("[usage] failed to record completion", error);
  }
}

/** One accepted upload. `quantity` is bytes — see the `usage_kind` enum. */
export async function recordUploadUsage(input: {
  userId: string;
  byteSize: number;
}): Promise<void> {
  try {
    await db.insert(usageEvents).values({
      userId: input.userId,
      kind: "upload",
      quantity: input.byteSize,
      costCents: 0,
      source: "vercel-blob",
    });
  } catch (error) {
    console.error("[usage] failed to record upload", error);
  }
}
