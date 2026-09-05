import type { RetrievedPassage } from "@/lib/retrieval";

/**
 * CITATION VALIDATION.
 *
 * The model is instructed to cite only the markers it was given. This file is
 * what makes that true rather than hoped for.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY AN INVALID MARKER IS A BUG, NOT A COSMETIC PROBLEM
 *
 * An answer ending in "[9]" when six passages were retrieved is not a rendering
 * glitch. It is the model asserting a source that does not exist — which means
 * the claim in front of it came from somewhere other than the documents. The
 * marker is the only thing distinguishing a grounded claim from an invented
 * one, so a marker that resolves to nothing is a claim with no provenance
 * wearing the costume of one.
 *
 * Left in the text it is worse than an uncited sentence, because the reader
 * has been given a reason to trust it. The chip would render, the click would
 * do nothing or land somewhere arbitrary, and the failure would look like a UI
 * bug rather than a faithfulness one.
 *
 * So out-of-range markers are STRIPPED from the text before it is stored,
 * counted, and logged against the message id. The surviving claim stands
 * uncited — visibly weaker, which is the honest presentation.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY NOT DONE
 *
 * No attempt to "repair" a bad marker by guessing which passage was meant.
 * Mapping [9] to the nearest valid number, or to the most similar passage,
 * would manufacture a provenance the model never claimed — inventing evidence
 * to cover for invented evidence. Stripping is the only safe move.
 */

/**
 * A citation marker in the answer text.
 *
 * Matches `[1]`, `[12]`. Deliberately narrow: digits only, no whitespace, no
 * ranges, no letters. Markdown links (`[text](url)`) and footnote syntax
 * (`[^1]`) do not match, which matters because the answer is rendered as
 * markdown and a looser pattern would eat real formatting.
 *
 * A leading zero is not matched (`[01]`) — the model was never given such a
 * marker, so treating it as valid would be inventing a mapping.
 */
const MARKER = /\[([1-9]\d*)\]/g;

export interface CitationRecord {
  /** The number as it appears in the text. */
  marker: number;
  /** What the marker resolves to. */
  chunkId: string;
  documentId: string;
  documentTitle: string;
  pageFrom: number;
  pageTo: number;
  /** The passage text, stored so a citation survives re-ingestion of its chunk. */
  quotedText: string;
}

export interface ValidationResult {
  /** The answer with out-of-range markers removed. */
  text: string;
  /** Citations that resolved, in first-appearance order. */
  citations: CitationRecord[];
  /** Markers the model invented, deduplicated. Empty is the normal case. */
  invalidMarkers: number[];
  /** Markers that were offered and never used. Not an error — just unused context. */
  unusedMarkers: number[];
}

/** Every distinct marker in the text, in order of first appearance. */
export function parseMarkers(text: string): number[] {
  const seen = new Set<number>();
  const order: number[] = [];

  for (const match of text.matchAll(MARKER)) {
    const marker = Number(match[1]);
    if (!seen.has(marker)) {
      seen.add(marker);
      order.push(marker);
    }
  }

  return order;
}

/**
 * Remove a marker from the text, along with the whitespace it leaves behind.
 *
 * Stripping `[9]` from "...notice [9]. The party..." naively leaves a space
 * before the full stop. The tidy-up is not cosmetic fussiness — the answer is
 * stored and re-rendered, so the damage is permanent, and a reader who spots
 * mangled punctuation reasonably distrusts the rest.
 */
function stripMarkers(text: string, invalid: Set<number>): string {
  if (invalid.size === 0) return text;

  return (
    text
      .replace(MARKER, (match, digits: string) =>
        invalid.has(Number(digits)) ? "" : match,
      )
      // A space stranded before punctuation by the removal.
      .replace(/[ \t]+([.,;:!?)\]])/g, "$1")
      // Two spaces where a marker used to sit between words.
      .replace(/[ \t]{2,}/g, " ")
      // A line that is now only whitespace.
      .replace(/[ \t]+$/gm, "")
      .trim()
  );
}

/**
 * Validate an answer's citations against the passages it was given.
 *
 * Pure and synchronous: no database, no logging, no side effects. Persistence
 * and the violation log live in `answer.ts`, so this can be tested against a
 * string and a passage list with nothing else in scope — which is what makes
 * the out-of-range case cheap enough to test properly.
 */
export function validateCitations(
  text: string,
  passages: RetrievedPassage[],
): ValidationResult {
  const byMarker = new Map(passages.map((passage) => [passage.marker, passage]));
  const used = parseMarkers(text);

  const invalid = new Set<number>();
  const citations: CitationRecord[] = [];

  for (const marker of used) {
    const passage = byMarker.get(marker);
    if (!passage) {
      invalid.add(marker);
      continue;
    }

    citations.push({
      marker,
      // The best-ranked constituent when adjacent chunks were merged into one
      // passage — that is what the citation chip scrolls to.
      chunkId: passage.primaryChunkId,
      documentId: passage.documentId,
      documentTitle: passage.documentTitle,
      pageFrom: passage.pageFrom,
      pageTo: passage.pageTo,
      // Stored on the row: `citations.chunk_id` is ON DELETE SET NULL, so
      // re-ingesting a document must not erase what an old answer quoted.
      quotedText: passage.text,
    });
  }

  const usedSet = new Set(used);
  const unusedMarkers = passages
    .map((passage) => passage.marker)
    .filter((marker) => !usedSet.has(marker));

  return {
    text: stripMarkers(text, invalid),
    citations,
    invalidMarkers: [...invalid].sort((a, b) => a - b),
    unusedMarkers,
  };
}
