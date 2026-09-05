import type { UIMessage } from "ai";

/**
 * THE CONVERSATION WIRE FORMAT.
 *
 * Everything that travels between the answer engine and the conversation pane,
 * declared in one place and importable from BOTH sides. Nothing in this file
 * touches Drizzle, Postgres, or the AI SDK's server surface — a Client
 * Component can import it without dragging the database driver into the
 * browser bundle, which is the same reason `document-status.ts` exists.
 *
 * These are deliberately NOT the server's own types. `RetrievalCandidate`
 * carries the full passage text — up to ~380 tokens each, for up to a hundred
 * candidates — and the trace table shows a one-line excerpt. Shipping the
 * server type verbatim would put a few hundred kilobytes of text on the wire
 * per answer to render a column that truncates it. So the trace row is a
 * separate, narrower shape and the truncation happens on the server.
 */

/** A validated citation, as the chip and its preview need it. */
export interface UICitation {
  /** The [n] in the answer text. */
  marker: number;
  /** Null once the chunk has been replaced by a re-ingestion. */
  chunkId: string | null;
  documentId: string;
  documentTitle: string;
  pageFrom: number;
  pageTo: number;
  /** The passage as it was quoted. Null only for very old rows. */
  quotedText: string | null;
}

/**
 * One row of the "Show retrieval" table.
 *
 * Ranks are 1-BASED and null when that channel never returned the passage.
 * Null is not zero, and the table renders it as an em dash rather than a
 * number — "the lexical channel ranked this 40th" and "the lexical channel
 * never saw this" are different facts.
 */
export interface UITraceRow {
  chunkId: string | null;
  documentId: string | null;
  documentTitle: string | null;
  /** A one-line excerpt. The full text lives in the database. */
  snippet: string;
  pageFrom: number | null;
  pageTo: number | null;

  denseRank: number | null;
  denseScore: number | null;
  lexicalRank: number | null;
  lexicalScore: number | null;
  rrfScore: number | null;
  rerankScore: number | null;

  /** True when this passage's text actually reached the model. */
  used: boolean;
}

/**
 * The quiet footer under an answer: what served it and what it cost.
 *
 * `costCents` is zero on the free pool and that is the real number, not an
 * estimate — see the header of src/lib/llm/answer.ts. Tokens and latency are
 * the measurements that would turn into money first.
 */
export interface AnswerMetadata {
  /** The `messages` row id. Present once the answer has been persisted. */
  messageId?: string;
  /** The model that ACTUALLY served this, after any failover. Null = no model. */
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  costCents: number;
  latencyMs: number;
  finishReason: string | null;
  /** Markers the model invented and that were stripped. Empty is normal. */
  invalidMarkers: number[];
}

/**
 * Custom data parts.
 *
 * Both arrive as ONE part rather than incrementally: retrieval has already
 * assigned every marker before the first token, so streaming citations
 * piecemeal would be theatre. They are NOT transient — they stay in
 * `message.parts`, and `loadConversationThread` rebuilds identical parts when a
 * thread is read back from the database, so a reloaded answer renders exactly
 * like a streamed one.
 *
 * Markers the model INVENTED are not here; they arrive on the metadata, at the
 * same moment, because they are a property of the generation rather than of the
 * evidence. The renderer strips them from the displayed text so the live view
 * converges with what was stored — see `stripInvalidMarkers`.
 */
export type MarginaliaDataParts = {
  citations: { citations: UICitation[] };
  trace: { rows: UITraceRow[] };
};

export type MarginaliaUIMessage = UIMessage<
  AnswerMetadata,
  MarginaliaDataParts
>;

/** A document as the scope selector and the ink assignment need it. */
export interface ScopeDocument {
  id: string;
  title: string;
  /** Only `ready` documents can be searched; the rest explain the dead composer. */
  status: string;
  ready: boolean;
}

/** The conversation itself, as the rail and the pane header need it. */
export interface ConversationSummary {
  id: string;
  title: string | null;
  documentIds: string[];
  updatedAt: string;
}

/* ── PART ACCESSORS ────────────────────────────────────────────────────────
 * `message.parts` is a union. These three keep the `part.type === "data-..."`
 * narrowing in one place instead of at every render site.
 */

export function messageText(message: MarginaliaUIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function messageCitations(
  message: MarginaliaUIMessage,
): MarginaliaDataParts["citations"] | null {
  for (const part of message.parts) {
    if (part.type === "data-citations") return part.data;
  }
  return null;
}

export function messageTrace(
  message: MarginaliaUIMessage,
): MarginaliaDataParts["trace"] | null {
  for (const part of message.parts) {
    if (part.type === "data-trace") return part.data;
  }
  return null;
}
