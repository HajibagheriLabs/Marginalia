import type { RetrievalCandidate, RetrievedPassage } from "@/lib/retrieval";

import type { CitationRecord } from "./citations";

/**
 * THE ANSWER ENGINE'S BOUNDARY.
 *
 * Everything the route handler and the eventual chat UI are allowed to know.
 * Deliberately does not expose the AI SDK's own types: the model is a string in
 * an env var and a provider behind one function, and leaking `LanguageModel`
 * out of this module would make swapping it a change at every call site.
 */

/** Why an answer stopped, without calling a model. */
export type ShortCircuitReason =
  | "no_documents"
  | "document_not_ready"
  | "no_relevant_passages";

/**
 * What the caller streams to the client.
 *
 * `citations` arrive as ONE event rather than incrementally. They are known in
 * full before the first token — retrieval assigned every marker already — so
 * streaming them piecemeal would be theatre. The client renders chips as
 * markers appear in the text, matching them against this list.
 */
export type AnswerEvent =
  | { type: "start"; passages: RetrievedPassage[]; model: string }
  | { type: "text"; delta: string }
  | { type: "citations"; citations: CitationRecord[] }
  | { type: "done"; message: AnswerSummary }
  | { type: "error"; message: string };

/** Recorded on the message row once generation completes. */
export interface AnswerSummary {
  messageId: string;
  /** The model that ACTUALLY served the request, after any failover. */
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  /** Integer cents. Zero for a `:free` model — the real number, not an estimate. */
  costCents: number;
  latencyMs: number;
  finishReason: string | null;
  /** Markers the model invented and that were stripped. Empty is normal. */
  invalidMarkers: number[];
}

export interface AnswerParams {
  userId: string;
  conversationId: string;
  /** The conversation's document scope. */
  documentIds: string[];
  question: string;
  /** Cancels generation and the underlying HTTP request. */
  signal?: AbortSignal;
  /** Test seam. Production passes nothing. */
  deps?: AnswerDeps;
}

/**
 * A model call, reduced to what this module actually needs.
 *
 * The seam exists so the tests can drive the whole pipeline — prompt, stream,
 * validation, persistence — against a scripted response. Mocking the AI SDK
 * itself would mean asserting that this file calls the functions this file
 * calls; mocking at this line asserts what happens to a model's OUTPUT, which
 * is where every interesting failure lives.
 */
export interface ModelRunner {
  /**
   * Stream one completion. Yields text deltas.
   *
   * Throws on failure. Failover across the pool happens ABOVE this, so an
   * implementation only ever speaks for one model.
   */
  stream(input: {
    modelId: string;
    system: string;
    prompt: string;
    signal?: AbortSignal;
  }): AsyncIterable<string>;

  /** Populated once the stream completes. Null fields mean the provider omitted them. */
  lastUsage(): {
    promptTokens: number | null;
    completionTokens: number | null;
    finishReason: string | null;
  };
}

export interface AnswerDeps {
  runner?: ModelRunner;
  /** Overrides the configured pool. Tests use a single fake id. */
  models?: string[];
  /** Skips retrieval; the tests supply passages directly. */
  retrieval?: {
    passages: RetrievedPassage[];
    candidates: RetrievalCandidate[];
  };
}

/** A failure the user should see verbatim. */
export class AnswerError extends Error {
  readonly reason: string;

  constructor(message: string, reason: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AnswerError";
    this.reason = reason;
  }
}
