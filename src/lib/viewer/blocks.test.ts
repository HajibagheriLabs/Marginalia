import { describe, expect, it } from "vitest";

import {
  estimateTextPageHeight,
  segmentBlock,
  splitBlocks,
  type TextBlock,
} from "./blocks";

/**
 * THE OFFSET GUARANTEE, ON THE RENDERING SIDE.
 *
 * Extraction promises that `text.slice(page.charStart, page.charEnd)` is the
 * page. This module has to keep that promise all the way down to the DOM: a
 * citation's `char_start` is resolved by counting characters through the
 * rendered runs, so a partition that loses or shifts a single character puts
 * every highlight after it in the wrong place — silently, because nothing
 * downstream can tell a wrong offset from a right one.
 *
 * Every test here is a form of "the pieces still add up to the whole".
 */

const PAGE = [
  "7.1 Termination for convenience",
  "",
  "Either party may terminate for convenience upon sixty (60) days\nprior written notice.",
  "",
  "",
  "Fees accrued before termination remain payable.",
].join("\n");

describe("splitBlocks", () => {
  it("splits on blank lines", () => {
    expect(splitBlocks(PAGE)).toHaveLength(3);
  });

  it("records offsets that index the page exactly", () => {
    for (const block of splitBlocks(PAGE)) {
      expect(PAGE.slice(block.charStart, block.charStart + block.text.length))
        .toBe(block.text);
    }
  });

  it("keeps line breaks inside a paragraph", () => {
    // Reflowing here would put the DOM one character per line ahead of the
    // stored offsets. It is also wrong for Markdown, where a hard wrap is
    // something the author typed.
    expect(splitBlocks(PAGE)[1].text).toContain("\n");
  });

  it("accounts for a separator of any length", () => {
    // "\n\n" and "\n\n\n" are different numbers of characters, and guessing
    // one of them would drift the rest of the page by one.
    const blocks = splitBlocks("a\n\n\n\nb");
    expect(blocks).toHaveLength(2);
    expect(blocks[1].charStart).toBe(5);
  });

  it("handles a page with no blank lines at all", () => {
    const blocks = splitBlocks("one line only");
    expect(blocks).toEqual([{ charStart: 0, text: "one line only" }]);
  });

  it("returns nothing for an empty page", () => {
    expect(splitBlocks("")).toEqual([]);
  });
});

describe("segmentBlock", () => {
  const block: TextBlock = { charStart: 100, text: "notice and more notice" };

  it("returns the whole block when nothing matched", () => {
    expect(segmentBlock(block, [])).toEqual([
      { text: "notice and more notice", charStart: 100, matchIndex: null },
    ]);
  });

  it("partitions the block exactly", () => {
    const segments = segmentBlock(block, [
      { match: { start: 100, length: 6 }, index: 0 },
      { match: { start: 116, length: 6 }, index: 1 },
    ]);

    expect(segments.map((segment) => segment.text).join("")).toBe(block.text);
    expect(segments.map((segment) => segment.matchIndex)).toEqual([
      0,
      null,
      1,
    ]);
  });

  it("keeps every segment's offset addressable", () => {
    const segments = segmentBlock(block, [
      { match: { start: 116, length: 6 }, index: 4 },
    ]);

    for (const segment of segments) {
      const local = segment.charStart - block.charStart;
      expect(block.text.slice(local, local + segment.text.length)).toBe(
        segment.text,
      );
    }
  });

  it("carries the document-wide match index down to the mark", () => {
    // Not the index within this page: it is what "3 of 47" counts and what
    // next/previous steps through.
    const segments = segmentBlock(block, [
      { match: { start: 100, length: 6 }, index: 41 },
    ]);
    expect(segments[0].matchIndex).toBe(41);
  });

  it("clips a match that runs past the end of the block", () => {
    // A whitespace-flexible query can match across the blank line between two
    // blocks. Half a highlight beats none — the count already told the reader
    // the match is there.
    const segments = segmentBlock(block, [
      { match: { start: 116, length: 40 }, index: 0 },
    ]);
    expect(segments.map((segment) => segment.text).join("")).toBe(block.text);
    expect(segments[segments.length - 1].matchIndex).toBe(0);
  });

  it("clips a match that starts before the block", () => {
    const segments = segmentBlock(block, [
      { match: { start: 80, length: 26 }, index: 0 },
    ]);
    expect(segments.map((segment) => segment.text).join("")).toBe(block.text);
    expect(segments[0].matchIndex).toBe(0);
    expect(segments[0].charStart).toBe(100);
  });

  it("ignores a match that does not touch the block", () => {
    expect(
      segmentBlock(block, [{ match: { start: 5, length: 3 }, index: 0 }]),
    ).toEqual([
      { text: "notice and more notice", charStart: 100, matchIndex: null },
    ]);
  });

  it("lets the first of two overlapping matches win", () => {
    // Two highlights on the same word cannot be drawn, and a naive
    // implementation emits a negative-length slice trying.
    const segments = segmentBlock(block, [
      { match: { start: 100, length: 10 }, index: 0 },
      { match: { start: 104, length: 10 }, index: 1 },
    ]);
    expect(segments.map((segment) => segment.text).join("")).toBe(block.text);
    expect(segments.every((segment) => segment.text.length > 0)).toBe(true);
  });
});

describe("estimateTextPageHeight", () => {
  it("grows with the amount of text", () => {
    expect(estimateTextPageHeight(3000)).toBeGreaterThan(
      estimateTextPageHeight(300),
    );
  });

  it("is never zero, so a placeholder is never invisible", () => {
    expect(estimateTextPageHeight(0)).toBeGreaterThan(0);
  });
});
