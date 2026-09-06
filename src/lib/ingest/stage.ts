import type { EmbeddingProvider } from "@/lib/embeddings";
import type { VectorStore } from "@/lib/vector";
import type { ChunkOptions } from "./chunk";

/**
 * THE STAGE CONTRACT.
 *
 * Ingestion is four pieces of work with one shape:
 *
 *   uploaded → EXTRACTING → CHUNKING → EMBEDDING → INDEXING → ready | failed
 *
 * A stage takes a document id and a user id, does one kind of work, and either
 * returns or throws. That is the whole interface, and the narrowness is the
 * point — three properties fall out of it that the pipeline depends on.
 *
 * 1. STAGES DO NOT MANAGE STATUS. A stage never writes `documents.status`,
 *    never decides what runs next, and never schedules anything. The
 *    orchestrator claims the stage, runs it, and advances or fails the row.
 *    This is what makes the orchestrator swappable: replacing it with a real
 *    queue means writing a consumer that calls these same four functions in
 *    the same order, and changing nothing here. A stage that set its own status
 *    would be a stage that had opinions about scheduling.
 *
 * 2. STAGES ARE IDEMPOTENT. Running one twice must leave the same state as
 *    running it once — no duplicated pages, chunks, or vector points. Each
 *    achieves it differently, and each says how in its own file: extraction and
 *    chunking delete-then-write inside a transaction, embedding skips chunks
 *    that are already marked indexed and upserts by chunk id, indexing is a
 *    check that writes nothing but the final flags. Idempotence is not a nicety
 *    here; it is the only reason a retry can resume mid-pipeline instead of
 *    starting over.
 *
 * 3. STAGES ARE RESUMABLE WITHIN THEMSELVES. A stage may run out of time
 *    before it runs out of work — a 600-passage document will not embed inside
 *    one function invocation. Returning `{ complete: false }` says "I made
 *    progress, call me again", and the orchestrator does exactly that. Nothing
 *    is lost between invocations because progress is recorded in the database
 *    as it happens, not accumulated in memory and written at the end.
 */

import type { DocumentStatus } from "@/db/schema";

/** The four stages that do work. `ready` and `failed` are outcomes, not stages. */
export type StageName = Extract<
  DocumentStatus,
  "extracting" | "chunking" | "embedding" | "indexing"
>;

export interface StageResult {
  /**
   * False when the stage made progress but has more to do. The orchestrator
   * re-runs the same stage rather than advancing.
   */
  complete: boolean;
  /** One line for the log. Not shown to the user. */
  detail?: string;
}

/**
 * A failure with a message written for the person who uploaded the file.
 *
 * The distinction matters at the point of catching: a `StageError`'s message
 * goes straight into `documents.error_message` and onto the screen, and
 * anything else is a bug whose text must never be shown — it gets logged and
 * replaced with something generic. Same rule extraction already used, lifted
 * here so all four stages share it.
 */
export class StageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StageError";
  }
}

/**
 * Everything a stage needs from the outside world, injectable.
 *
 * Production passes nothing and gets the real provider, the real store, and a
 * generous deadline. Tests pass an embedding provider that fails on the 3rd
 * batch, or a vector store pointed at a throwaway collection, and get to
 * exercise the failure and retry paths for real rather than by mocking the
 * database underneath them.
 */
export interface StageDeps {
  embeddings?: EmbeddingProvider;
  vectors?: VectorStore;
  /**
   * Overrides for the chunking budget. Production passes nothing and gets
   * `CHUNKING`.
   *
   * The seam exists because chunk size, overlap, and the section-break ratio
   * are the ingestion-side knobs the eval harness sweeps, and sweeping them
   * has to re-run THIS stage rather than a copy of it — a second chunk-and-
   * insert path written for the eval would be measuring code that does not
   * ship. Several of the comments on `CHUNKING` end in "worth measuring once
   * the eval harness exists"; this is what makes that possible.
   */
  chunkOptions?: ChunkOptions;
  /**
   * `Date.now()` after which the stage should stop taking NEW work and return
   * `{ complete: false }`. It is a deadline for starting a batch, not for
   * finishing one — a stage never abandons work in flight, because a half-
   * written batch is exactly the state idempotence is meant to avoid.
   */
  deadline?: number;
}

export type StageRunner = (
  documentId: string,
  userId: string,
  deps?: StageDeps,
) => Promise<StageResult>;

/** Never let a stage run without a deadline; an unbounded loop is a hung function. */
export function deadlineFrom(deps: StageDeps | undefined, fallbackMs: number): number {
  return deps?.deadline ?? Date.now() + fallbackMs;
}
