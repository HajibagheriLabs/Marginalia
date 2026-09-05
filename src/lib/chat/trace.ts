import type { RetrievalCandidate } from "@/lib/retrieval";

import type { UITraceRow } from "./types";

/**
 * Narrowing a retrieval candidate down to a trace row.
 *
 * The one thing this does is TRUNCATE. A `RetrievalCandidate` carries the full
 * passage — up to ~380 tokens — and there can be a hundred of them behind one
 * answer. Sent verbatim that is a few hundred kilobytes per answer to populate
 * a table column that shows a line and a half. The full text is a click away
 * in the reading pane, which is where it belongs.
 *
 * Everything else passes through unchanged, including the nulls. A null rank
 * means the channel never returned the passage, and the table renders it as an
 * em dash rather than a zero — see `UITraceRow`.
 */

/** One line and a half at 12px mono in a 400–520px pane. */
export const TRACE_SNIPPET_CHARS = 180;

export function excerpt(text: string, limit = TRACE_SNIPPET_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit).trimEnd()}…` : flat;
}

export function toUITraceRow(candidate: RetrievalCandidate): UITraceRow {
  return {
    chunkId: candidate.chunkId,
    documentId: candidate.documentId,
    documentTitle: candidate.documentTitle,
    snippet: excerpt(candidate.text),
    pageFrom: candidate.pageFrom,
    pageTo: candidate.pageTo,
    denseRank: candidate.denseRank,
    denseScore: candidate.denseScore,
    lexicalRank: candidate.lexicalRank,
    lexicalScore: candidate.lexicalScore,
    rrfScore: candidate.rrfScore,
    rerankScore: candidate.rerankScore,
    used: candidate.used,
  };
}
