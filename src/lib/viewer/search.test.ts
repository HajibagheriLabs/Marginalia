import { describe, expect, it } from "vitest";

import {
  compileQuery,
  findMatches,
  matchesOnPage,
  MIN_QUERY_LENGTH,
  searchPages,
} from "./search";

/**
 * IN-DOCUMENT SEARCH, tested as pure functions.
 *
 * The cases here are the ones that decide whether search is usable on a real
 * contract: a phrase broken across a line, a clause number full of regex
 * metacharacters, and a query that matches half the document.
 */

describe("compileQuery", () => {
  it("refuses a query too short to mean anything", () => {
    expect(compileQuery("")).toBeNull();
    expect(compileQuery(" ")).toBeNull();
    expect(compileQuery("a")).toBeNull();
    expect(compileQuery("ab")).not.toBeNull();
    expect(MIN_QUERY_LENGTH).toBe(2);
  });

  it("treats the query as characters, not as a pattern", () => {
    // A reader searching for a clause reference is searching for those
    // characters. Unescaped, "s.7(2)" is a regex with a capture group and a
    // wildcard, and it would match "sX72" and nothing they wanted.
    const matcher = compileQuery("s.7(2)")!;
    expect(findMatches("see s.7(2) below", matcher)).toEqual([
      { start: 4, length: 6 },
    ]);
    expect(findMatches("sX7 2 below", matcher)).toEqual([]);
  });

  it("matches a money amount literally", () => {
    const matcher = compileQuery("$1,000.00")!;
    expect(findMatches("a fee of $1,000.00 is due", matcher)).toHaveLength(1);
    expect(findMatches("a fee of $1500x00 is due", matcher)).toHaveLength(0);
  });
});

describe("findMatches", () => {
  it("is case-insensitive", () => {
    const matcher = compileQuery("termination")!;
    expect(findMatches("TERMINATION and Termination", matcher)).toHaveLength(2);
  });

  it("matches a phrase across the line break the PDF put in it", () => {
    // Extraction deliberately preserves line structure — reflowing would break
    // citation highlighting — so almost every multi-word phrase in a real PDF
    // is stored with a newline somewhere in it. Without this, phrase search on
    // a PDF finds nothing and looks broken.
    const matcher = compileQuery("written notice")!;
    const text = "upon sixty days prior written\nnotice to the other party";
    const matches = findMatches(text, matcher);

    expect(matches).toHaveLength(1);
    expect(text.slice(matches[0].start, matches[0].start + matches[0].length))
      .toBe("written\nnotice");
  });

  it("matches across a run of spaces, not only a single one", () => {
    const matcher = compileQuery("for convenience")!;
    expect(findMatches("terminate  for    convenience upon", matcher)).toHaveLength(1);
  });

  it("does not carry its position from one page to the next", () => {
    // A compiled matcher is reused across every page of the document. A global
    // regex that kept its `lastIndex` would silently miss matches near the
    // start of every page after the first.
    const matcher = compileQuery("notice")!;
    const first = "a notice near the end of a long page, and another notice";
    expect(findMatches(first, matcher)).toHaveLength(2);
    expect(findMatches("notice", matcher)).toHaveLength(1);
    expect(findMatches("notice", matcher)).toHaveLength(1);
  });
});

describe("searchPages", () => {
  const pages = [
    { pageNumber: 1, text: "Notice must be given in writing." },
    { pageNumber: 2, text: "No relevant term here." },
    { pageNumber: 3, text: "Written notice, and further notice." },
  ];

  it("returns matches in document order", () => {
    const { matches } = searchPages(pages, "notice");
    expect(matches.map((match) => match.pageNumber)).toEqual([1, 3, 3]);
  });

  it("returns nothing for a query below the minimum", () => {
    expect(searchPages(pages, "n")).toEqual({ matches: [], truncated: false });
  });

  it("caps the result set and says that it did", () => {
    const many = [{ pageNumber: 1, text: "ab ".repeat(50) }];
    const { matches, truncated } = searchPages(many, "ab", 10);
    expect(matches).toHaveLength(10);
    // The count the UI shows becomes a floor rather than a total, and the bar
    // renders "10+" — reporting the cap as a total would be a number the
    // search already knows is wrong.
    expect(truncated).toBe(true);
  });

  it("does not report truncation when everything fit", () => {
    expect(searchPages(pages, "notice", 10).truncated).toBe(false);
  });

  it("finds nothing in a document that does not contain the term", () => {
    expect(searchPages(pages, "indemnity").matches).toEqual([]);
  });
});

describe("matchesOnPage", () => {
  it("keeps each match's index in the document-wide list", () => {
    // The index is what "3 of 47" counts and what next/previous steps through,
    // so it has to survive being grouped by page.
    const { matches } = searchPages(
      [
        { pageNumber: 1, text: "notice" },
        { pageNumber: 2, text: "notice and notice" },
      ],
      "notice",
    );

    expect(matchesOnPage(matches, 2).map((entry) => entry.index)).toEqual([1, 2]);
    expect(matchesOnPage(matches, 1).map((entry) => entry.index)).toEqual([0]);
    expect(matchesOnPage(matches, 3)).toEqual([]);
  });
});
