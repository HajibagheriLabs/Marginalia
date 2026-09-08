/**
 * Usage accounting and limit enforcement.
 *
 *   limits.ts (isomorphic)  the NUMBERS and the sentences that explain them
 *   guard.ts                enforcement, inside the transaction of each write
 *   pricing.ts              the per-model price table — every entry zero, and
 *                           the comment there explains why it exists anyway
 *   record.ts               writes into `usage_events`
 *   summary.ts              what the settings page reads back
 */
export { LimitError } from "./guard";
export {
  assertDailySpendAllowance,
  assertPageAllowance,
  countQuestionsToday,
  countSpendToday,
  countUserDocuments,
  countUserPages,
  insertDocumentWithinLimit,
  insertUserMessageWithinLimit,
} from "./guard";
export {
  LOCAL_PRICE,
  MODEL_PRICES,
  completionCostCents,
  formatCost,
  priceFor,
  type ModelPrice,
} from "./pricing";
export {
  recordCompletionUsage,
  recordEmbeddingUsage,
  recordUploadUsage,
} from "./record";
export {
  readLimitsReport,
  readMonthlyUsage,
  type LimitUsage,
  type LimitsReport,
  type MonthlyUsage,
  type UsageBucket,
} from "./summary";
