import { and, eq, gte, sql } from "drizzle-orm";

import { db } from "@/db";
import { usageEvents } from "@/db/schema";
import type { UsageKind } from "@/db/schema";
import { FREE_POOL, LIMITS, startOfUtcMonth } from "@/lib/limits";
import { freePoolState } from "@/lib/rate-limit";

import {
  countQuestionsToday,
  countUserDocuments,
  countUserPages,
} from "./guard";

/**
 * WHAT THE SETTINGS PAGE READS.
 *
 * Two shapes: where this account stands against each limit, and what it has
 * spent this month.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE MONTHLY SUMMARY REPORTS TOKENS AND REQUESTS, NOT DOLLARS.
 *
 * There is a `cost_cents` column, it is summed here, and it is zero — because
 * every model is a `:free` variant and embeddings run on this server's CPU. A
 * "$0.00 spent this month" headline would be true and useless: it says nothing
 * about how much work was done, and it invites the reader to assume the number
 * is an estimate that got rounded away.
 *
 * So the summary leads with the measurements that are real — tokens embedded,
 * tokens generated, requests made, compute time spent — and mentions the price
 * only as the qualifier "free tier". The cost machinery is still here and
 * still correct; it just has nothing interesting to say yet, and pretending
 * otherwise would be the dishonest option.
 */

export interface UsageBucket {
  kind: UsageKind;
  /** Rows: embedding batches, completions, uploads. */
  events: number;
  /** Tokens for embedding and completion; bytes for upload. */
  quantity: number;
  costCents: number;
  /** Summed wall-clock time, where the event recorded any. */
  durationMs: number;
}

export interface MonthlyUsage {
  /** ISO 8601, UTC. The window this covers. */
  since: string;
  embedding: UsageBucket;
  completion: UsageBucket;
  upload: UsageBucket;
  /** Sum across every kind. Zero on the free tier, and that is the real value. */
  costCents: number;
}

const EMPTY = (kind: UsageKind): UsageBucket => ({
  kind,
  events: 0,
  quantity: 0,
  costCents: 0,
  durationMs: 0,
});

/**
 * This user's usage since the first of the UTC month.
 *
 * One grouped query rather than three. The index on
 * (user_id, created_at DESC) covers the predicate; the grouping is over the
 * handful of rows it returns.
 */
export async function readMonthlyUsage(userId: string): Promise<MonthlyUsage> {
  const since = startOfUtcMonth();

  const rows = await db
    .select({
      kind: usageEvents.kind,
      events: sql<number>`count(*)::int`,
      quantity: sql<number>`coalesce(sum(${usageEvents.quantity}), 0)::bigint`,
      costCents: sql<number>`coalesce(sum(${usageEvents.costCents}), 0)::int`,
      durationMs: sql<number>`coalesce(sum(${usageEvents.durationMs}), 0)::bigint`,
    })
    .from(usageEvents)
    .where(
      and(eq(usageEvents.userId, userId), gte(usageEvents.createdAt, since)),
    )
    .groupBy(usageEvents.kind);

  const summary: MonthlyUsage = {
    since: since.toISOString(),
    embedding: EMPTY("embedding"),
    completion: EMPTY("completion"),
    upload: EMPTY("upload"),
    costCents: 0,
  };

  for (const row of rows) {
    // `sum()` over a bigint comes back from postgres.js as a string, because a
    // Postgres bigint does not fit a JS number safely. These totals never
    // approach 2^53, so a Number() at the boundary is correct — but coercing
    // it deliberately is what stops "12" + "8" from concatenating downstream.
    const bucket: UsageBucket = {
      kind: row.kind,
      events: Number(row.events),
      quantity: Number(row.quantity),
      costCents: Number(row.costCents),
      durationMs: Number(row.durationMs),
    };
    summary[row.kind] = bucket;
    summary.costCents += bucket.costCents;
  }

  return summary;
}

/** One limit, and where this account stands against it. */
export interface LimitUsage {
  label: string;
  used: number;
  limit: number;
  /** How the numbers are read: "documents", "pages", "questions today". */
  unit: string;
  /** What happens when it is reached. Rendered under the bar. */
  note: string;
}

export interface LimitsReport {
  documents: LimitUsage;
  pages: LimitUsage;
  questions: LimitUsage;
  uploadBytes: number;
  /**
   * The shared model quota. APP-WIDE, not per account, and counted in the
   * limiter's memory rather than in Postgres — so this is what THIS instance
   * has seen, which is a floor on the true figure rather than the figure.
   * The settings page says so where it renders it.
   */
  freePool: {
    usedToday: number;
    limitToday: number;
    resetAt: string;
  };
}

export async function readLimitsReport(userId: string): Promise<LimitsReport> {
  const [documents, pages, questions] = await Promise.all([
    countUserDocuments(userId),
    countUserPages(userId),
    countQuestionsToday(userId),
  ]);

  const pool = freePoolState();

  return {
    documents: {
      label: "Documents",
      used: documents,
      limit: LIMITS.documents,
      unit: "documents",
      note: "Deleting a document frees a slot immediately.",
    },
    pages: {
      label: "Pages",
      used: pages,
      limit: LIMITS.totalPages,
      unit: "pages",
      note: "Counted across every document. Pages become passages, and passages become vectors.",
    },
    questions: {
      label: "Questions today",
      used: questions,
      limit: LIMITS.messagesPerDay,
      unit: "questions",
      note: "Resets at 00:00 UTC. Regenerating an answer does not count again.",
    },
    uploadBytes: LIMITS.uploadBytes,
    freePool: {
      usedToday: pool.usedToday,
      limitToday: FREE_POOL.requestsPerDay,
      resetAt: pool.resetAt.toISOString(),
    },
  };
}
