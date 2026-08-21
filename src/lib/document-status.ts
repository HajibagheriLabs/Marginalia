import type { DocumentStatus } from "@/db/schema";

/**
 * How the ingestion state machine is presented.
 *
 * The wording follows the UI writing rules: plain verbs, sentence case, no
 * filler, and no apology. `tone` selects one of the three SYSTEM STATE colours,
 * which are the only non-ink colours allowed anywhere in the interface — they
 * are chrome, they never appear on paper, and --warn is amber-orange precisely
 * so it can never be mistaken for citrine ink.
 *
 * `terminal` marks the two states that stop moving on their own. Everything
 * else is mid-flight and the UI may poll it.
 */

export type StatusTone = "neutral" | "progress" | "ready" | "failed";

export interface StatusMeta {
  /** Shown next to the dot. Sentence case, no trailing period. */
  label: string;
  tone: StatusTone;
  /** True when the document will not change state without a user action. */
  terminal: boolean;
}

export const DOCUMENT_STATUS_META: Record<DocumentStatus, StatusMeta> = {
  uploaded: { label: "Queued", tone: "neutral", terminal: false },
  extracting: { label: "Extracting text", tone: "progress", terminal: false },
  chunking: { label: "Splitting into passages", tone: "progress", terminal: false },
  embedding: { label: "Embedding", tone: "progress", terminal: false },
  indexing: { label: "Indexing", tone: "progress", terminal: false },
  ready: { label: "Ready", tone: "ready", terminal: true },
  failed: { label: "Failed", tone: "failed", terminal: true },
};

/**
 * Every state, in the order they are reached. Re-declared here rather than read
 * off `documentStatus.enumValues` so that client components can enumerate the
 * states without importing the Drizzle schema — and the whole postgres driver
 * behind it — into the browser bundle. `Record<DocumentStatus, ...>` above keeps
 * the two in step: adding a state to the enum fails to compile until it is
 * described here.
 */
export const ALL_DOCUMENT_STATUSES = Object.keys(
  DOCUMENT_STATUS_META,
) as DocumentStatus[];

/** The ordered stages a document walks through, for progress readouts. */
export const INGEST_STAGES: DocumentStatus[] = [
  "uploaded",
  "extracting",
  "chunking",
  "embedding",
  "indexing",
  "ready",
];

/** Only a ready document can be searched. */
export function isSearchable(status: DocumentStatus): boolean {
  return status === "ready";
}
