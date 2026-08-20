import { pgEnum } from "drizzle-orm/pg-core";

/**
 * The ingestion state machine. Each stage is idempotent and independently
 * re-runnable; `documents.failed_stage` reuses this enum to record which stage
 * a document died in, so a "Retry" resumes from exactly there.
 */
export const documentStatus = pgEnum("document_status", [
  "uploaded",
  "extracting",
  "chunking",
  "embedding",
  "indexing",
  "ready",
  "failed",
]);

/** Who produced a message. */
export const messageRole = pgEnum("message_role", [
  "user",
  "assistant",
  "system",
]);

/** What a usage event is billing for. Costs are always integer cents. */
export const usageKind = pgEnum("usage_kind", [
  "upload",
  "embedding",
  "completion",
]);
