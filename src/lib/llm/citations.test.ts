import { describe, expect, it } from "vitest";

import type { RetrievedPassage } from "@/lib/retrieval";

import { parseMarkers, validateCitations } from "./citations";

/**
 * THE CITATION CONTRACT, tested as pure functions.
 *
 * No database, no model, no network — validation is deliberately side-effect
 * free so the case that matters most (a marker the model invented) is cheap
 * enough to test exhaustively rather than once.
 */

function passage(marker: number, overrides: Partial<RetrievedPassage> = {}): RetrievedPassage {
  return {
    marker,
    chunkIds: [`chunk-${marker}`],
    primaryChunkId: `chunk-${marker}`,
    documentId: `doc-${marker}`,
    documentTitle: `Document ${marker}`,
    text: `Passage ${marker} text.`,
    tokenCount: 10,
    pageFrom: marker,
    pageTo: marker,
    charStart: 0,
    charEnd: 20,
    sectionPath: `Section ${marker}`,
    score: 1 / marker,
    ...overrides,
  };
}

describe("parseMarkers", () => {
  it("finds each distinct marker once, in order of first appearance", () => {
    expect(parseMarkers("A [2] then B [1] then C [2] again.")).toEqual([2, 1]);
  });

  it("finds none in text with no markers", () => {
    expect(parseMarkers("No citations at all.")).toEqual([]);
  });

  it("ignores markdown links and footnote syntax", () => {
    // The answer is rendered as markdown, so a looser pattern would eat real
    // formatting and strip it out of the stored text.
    expect(parseMarkers("See [the docs](https://example.com) and [^1].")).toEqual(
      [],
    );
  });

  it("ignores a leading zero", () => {
    // [01] was never offered to the model, so treating it as [1] would be
    // inventing a mapping rather than reading one.
    expect(parseMarkers("Claim [01].")).toEqual([]);
  });

  it("reads multi-digit markers", () => {
    expect(parseMarkers("Claim [12].")).toEqual([12]);
  });
});

describe("validateCitations", () => {
  const passages = [passage(1), passage(2), passage(3)];

  it("resolves a well-cited answer", () => {
    const text = "Notice is thirty days [1]. Payment is net 45 [3].";
    const result = validateCitations(text, passages);

    expect(result.text).toBe(text);
    expect(result.invalidMarkers).toEqual([]);
    expect(result.citations.map((c) => c.marker)).toEqual([1, 3]);
    expect(result.unusedMarkers).toEqual([2]);

    const [first] = result.citations;
    expect(first.chunkId).toBe("chunk-1");
    expect(first.documentId).toBe("doc-1");
    expect(first.pageFrom).toBe(1);
    // The passage text is stored, so a citation survives re-ingestion of its
    // chunk (citations.chunk_id is ON DELETE SET NULL).
    expect(first.quotedText).toBe("Passage 1 text.");
  });

  /* ====================================================================== *
   * THE CASE THIS FILE EXISTS FOR
   * ====================================================================== */

  it("strips a marker the model invented", () => {
    // Six passages offered, [9] cited. The claim in front of it came from
    // somewhere other than the documents, and the marker is the only thing
    // that would have made a reader trust it.
    const six = [1, 2, 3, 4, 5, 6].map((n) => passage(n));
    const text = "Termination needs notice [2]. The fee is waived [9].";

    const result = validateCitations(text, six);

    expect(result.invalidMarkers).toEqual([9]);
    expect(result.text).toBe("Termination needs notice [2]. The fee is waived.");
    // The valid citation survives; only the invented one is dropped.
    expect(result.citations.map((c) => c.marker)).toEqual([2]);
    // And nothing was invented to replace it — no guessing at what was meant.
    expect(result.citations).toHaveLength(1);
  });

  it("leaves the sentence readable after stripping", () => {
    // The answer is stored and re-rendered, so mangled punctuation is
    // permanent — and a reader who spots it reasonably distrusts the rest.
    const result = validateCitations(
      "The period is thirty days [7] , and notice must be written [9].",
      [passage(1)],
    );

    expect(result.text).toBe(
      "The period is thirty days, and notice must be written.",
    );
    expect(result.invalidMarkers).toEqual([7, 9]);
  });

  it("strips every occurrence of an invalid marker", () => {
    const result = validateCitations("A [5] and B [5] and C [1].", [
      passage(1),
    ]);

    expect(result.text).toBe("A and B and C [1].");
    expect(result.invalidMarkers).toEqual([5]);
  });

  it("reports invalid markers sorted and deduplicated", () => {
    const result = validateCitations("[9] [4] [9] [7]", [passage(1)]);
    expect(result.invalidMarkers).toEqual([4, 7, 9]);
  });

  it("handles an answer with no citations at all", () => {
    const result = validateCitations("Nothing here covers that.", passages);

    expect(result.citations).toEqual([]);
    expect(result.invalidMarkers).toEqual([]);
    expect(result.unusedMarkers).toEqual([1, 2, 3]);
    expect(result.text).toBe("Nothing here covers that.");
  });

  it("records a citation once even when the marker repeats", () => {
    // One row per marker: citations has a unique index on (message_id, marker),
    // so a duplicate would fail the insert.
    const result = validateCitations("A [1]. B [1]. C [1].", passages);

    expect(result.citations).toHaveLength(1);
    expect(result.citations[0].marker).toBe(1);
    expect(result.text).toBe("A [1]. B [1]. C [1].");
  });

  it("cites the primary chunk of a merged passage", () => {
    // Adjacent chunks are merged into one numbered passage; the citation must
    // point at the best-ranked constituent, which is what the chip scrolls to.
    const merged = passage(1, {
      chunkIds: ["chunk-a", "chunk-b"],
      primaryChunkId: "chunk-b",
    });

    const result = validateCitations("Claim [1].", [merged]);
    expect(result.citations[0].chunkId).toBe("chunk-b");
  });
});
