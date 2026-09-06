import { describe, expect, it } from "vitest";

import {
  locatePassage,
  MIN_SUBPHRASE_LENGTH,
  reduceForMatch,
} from "./passage";

/**
 * CITATION TARGETING, tested as a pure function.
 *
 * The rule this file defends is the one from the spec: NEVER HIGHLIGHT THE
 * WRONG TEXT, and never fail silently. So the cases below are, in order: the
 * ones that must match despite the renderer and the extractor disagreeing, and
 * the ones that must return null so the viewer falls back to marking the page.
 */

/** The passage as the extractor stored it — whitespace normalised, dehyphenated. */
const QUOTE =
  "Either party may terminate this Agreement for convenience upon sixty (60) days prior written notice to the other party.";

describe("reduceForMatch", () => {
  it("maps every reduced character back to a real source character", () => {
    const source = "The  quick\nbrown-fox";
    const reduced = reduceForMatch(source);

    expect(reduced.text).toBe("thequickbrownfox");
    expect(reduced.map).toHaveLength(reduced.text.length);
    for (let index = 0; index < reduced.text.length; index += 1) {
      expect(source[reduced.map[index]].toLowerCase()).toBe(reduced.text[index]);
    }
  });

  it("folds curly punctuation to ASCII", () => {
    expect(reduceForMatch("“the party’s”").text).toBe('"theparty\'s"');
  });

  it("drops soft hyphens and zero-width characters", () => {
    expect(reduceForMatch("ter­mi​nation").text).toBe("termination");
  });
});

describe("locatePassage", () => {
  it("finds a passage that is already identical", () => {
    const page = `7.1 Termination\n\n${QUOTE}\n\nFees remain payable.`;
    const match = locatePassage(page, QUOTE)!;

    expect(match.kind).toBe("exact");
    expect(match.coverage).toBe(1);
    expect(page.slice(match.start, match.end)).toBe(QUOTE);
  });

  it("finds a passage the text layer broke across lines", () => {
    // PDF.js reports one span per text item and the reader sees line breaks
    // the extractor removed. Without whitespace-insensitive matching this —
    // the single most common real case — fails on every multi-line citation.
    const page =
      "Either party may terminate this Agreement for\nconvenience upon sixty (60) days prior written\nnotice to the other party.";
    const match = locatePassage(page, QUOTE)!;

    expect(match.kind).toBe("exact");
    expect(page.slice(match.start, match.end)).toBe(page.trim());
  });

  it("finds a passage the text layer hyphenated", () => {
    // Extraction rejoins "termi-\nnation"; PDF.js does not. Both sides drop
    // hyphens, so the two forms reduce to the same string.
    const page =
      "Either party may termi-nate this Agreement for conve-nience upon sixty (60) days prior written notice to the other party.";
    const match = locatePassage(page, QUOTE)!;

    expect(match.kind).toBe("exact");
    expect(page.slice(match.start, match.end)).toContain("termi-nate");
  });

  it("finds a passage split by a font change mid-sentence", () => {
    // A bold run arrives as its own span with no space around it. Joining
    // spans with nothing is right here and wrong at a line end; removing
    // whitespace from both sides makes the choice irrelevant.
    const page =
      "Either party may terminate this Agreement for convenience upon " +
      "sixty (60)days prior written notice to the other party.";
    expect(locatePassage(page, QUOTE)!.kind).toBe("exact");
  });

  it("ignores case", () => {
    expect(locatePassage(QUOTE.toUpperCase(), QUOTE)!.kind).toBe("exact");
  });

  it("falls back to the longest matching prefix when the quote runs off the page", () => {
    // A chunk can span a page boundary, so the tail of the quote is simply not
    // on this page. Highlighting the half that IS here beats highlighting
    // nothing, and it is still the right words.
    const head = QUOTE.slice(0, 70);
    const match = locatePassage(`Clause 7.1\n\n${head}`, QUOTE)!;

    expect(match.kind).toBe("partial");
    expect(match.coverage).toBeLessThan(1);
    expect(match.coverage).toBeGreaterThan(0.4);
    expect(head).toContain(
      `Clause 7.1\n\n${head}`.slice(match.start, match.end).trim(),
    );
  });

  it("falls back to the longest matching suffix when the quote starts on the previous page", () => {
    const tail = QUOTE.slice(60);
    const match = locatePassage(`${tail}\n\nFees remain payable.`, QUOTE)!;

    expect(match.kind).toBe("partial");
    expect(`${tail}\n\nFees remain payable.`.slice(match.start, match.end))
      .toContain("written notice");
  });

  it("returns null when only a scrap of the quote is present", () => {
    // "party" appears; a five-character match is a coincidence, not evidence.
    // Null is the signal for the page-level fallback and its quiet note.
    expect(locatePassage("The party arrived.", QUOTE)).toBeNull();
  });

  it("refuses a fragment shorter than the floor", () => {
    const short = "a".repeat(MIN_SUBPHRASE_LENGTH - 1);
    expect(locatePassage(`xx ${short} xx`, `${short} something else`)).toBeNull();
  });

  it("accepts a fragment exactly at the floor", () => {
    const atFloor = "b".repeat(MIN_SUBPHRASE_LENGTH);
    const match = locatePassage(`zz ${atFloor} zz`, `${atFloor} tail`);
    expect(match).not.toBeNull();
    expect(match!.kind).toBe("partial");
  });

  it("returns null for an empty quote or an empty page", () => {
    expect(locatePassage("some page text", "")).toBeNull();
    expect(locatePassage("", QUOTE)).toBeNull();
    expect(locatePassage("   \n  ", QUOTE)).toBeNull();
  });

  it("returns a range that is inside the haystack", () => {
    const page = `preamble\n\n${QUOTE}\n\ntrailer`;
    const match = locatePassage(page, QUOTE)!;

    expect(match.start).toBeGreaterThanOrEqual(0);
    expect(match.end).toBeLessThanOrEqual(page.length);
    expect(match.start).toBeLessThan(match.end);
  });

  it("takes the first occurrence when a quote appears twice", () => {
    // Deliberate and documented: the citation row carries no offset to
    // disambiguate with, and a multi-sentence quote appearing twice on one
    // page does not happen in practice.
    const page = `${QUOTE}\n\nfiller\n\n${QUOTE}`;
    expect(locatePassage(page, QUOTE)!.start).toBe(0);
  });
});
