import { describe, expect, it } from "vitest";

import { assemblePages } from "./extract";
import {
  CHUNKING,
  SECTION_SEPARATOR,
  chunkDocument,
  countTokens,
  embeddingText,
  type ChunkOptions,
  type DocumentChunk,
  type PageSpan,
} from "./chunk";

/* ========================================================================== *
 * FIXTURES
 * ========================================================================== */

/**
 * A paragraph of roughly 55 tokens. Varying the number keeps every paragraph
 * textually distinct, so a test can tell which one it is looking at.
 */
function paragraph(n: number): string {
  return (
    `This is paragraph ${n} of the agreement, written so that the token ` +
    `counter has real prose to measure rather than filler. The parties agree ` +
    `that the provisions of this clause survive termination. Notice must be ` +
    `given in writing to the address set out in Schedule A.`
  );
}

/** Build a document out of paragraphs and headings, joined markdown-style. */
function document(...parts: string[]): string {
  return parts.join("\n\n");
}

/** One page spanning the whole document — for tests that do not care about pages. */
function singlePage(text: string): PageSpan[] {
  return [{ pageNumber: 1, charStart: 0, charEnd: text.length }];
}

/**
 * Paginate a document the way `extract.ts` does, so page offsets in these tests
 * are produced by the same code that produces them in production rather than by
 * arithmetic repeated here.
 */
function paginate(pageTexts: string[]): { text: string; pages: PageSpan[] } {
  const { text, pages } = assemblePages(pageTexts);
  return {
    text,
    pages: pages.map((page) => ({
      pageNumber: page.pageNumber,
      charStart: page.charStart,
      charEnd: page.charEnd,
    })),
  };
}

/* ========================================================================== *
 * INVARIANTS
 *
 * Asserted for every chunked document in this file rather than in one test of
 * their own, for the same reason `extract.test.ts` checks the offset guarantee
 * everywhere: these are properties of the chunker, not of a single input, and a
 * violation that only shows up on one fixture is the interesting kind.
 * ========================================================================== */

function expectChunkInvariants(
  text: string,
  chunks: DocumentChunk[],
  options: ChunkOptions = {},
): void {
  const min = options.minTokens ?? CHUNKING.minTokens;
  const max = options.maxTokens ?? CHUNKING.maxTokens;
  const target = options.targetTokens ?? CHUNKING.targetTokens;
  const overlap = Math.round(
    target * (options.overlapRatio ?? CHUNKING.overlapRatio),
  );
  // See the note on `overlapStartFor`: the packer budgets a chunk's own
  // content, then the merge pass may add up to `minTokens` and the overlap up
  // to twice its budget on top.
  const ceiling = max + min + overlap * 2;

  chunks.forEach((chunk, index) => {
    expect(chunk.ordinal).toBe(index);

    // THE OFFSET GUARANTEE. Chunk text is sliced, never constructed.
    expect(text.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text);
    expect(chunk.charStart).toBeGreaterThanOrEqual(0);
    expect(chunk.charEnd).toBeLessThanOrEqual(text.length);
    expect(chunk.charEnd).toBeGreaterThan(chunk.charStart);

    // No leading or trailing whitespace: boundaries land on real text.
    expect(chunk.text).toBe(chunk.text.trim());

    expect(chunk.tokenCount).toBe(countTokens(chunk.text));
    expect(chunk.tokenCount).toBeLessThanOrEqual(ceiling);

    expect(chunk.pageTo).toBeGreaterThanOrEqual(chunk.pageFrom);
  });

  // Chunks advance through the document and never repeat or reorder.
  for (let i = 1; i < chunks.length; i += 1) {
    expect(chunks[i].charStart).toBeGreaterThan(chunks[i - 1].charStart);
    expect(chunks[i].charEnd).toBeGreaterThan(chunks[i - 1].charEnd);
  }

  // The floor. A single-chunk document is exempt: there is no neighbour to
  // merge a short document into, and refusing to index it would be worse.
  if (chunks.length > 1) {
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeGreaterThanOrEqual(min);
    }
  }

  expectFullCoverage(text, chunks);
}

/**
 * COVERAGE. Every non-whitespace character belongs to at least one chunk.
 *
 * Stated in terms of content rather than as "the ranges tile the document",
 * because they deliberately do not: boundaries are trimmed, so the whitespace
 * between two spans belongs to neither. What must never happen is a character
 * with meaning falling into one of those gaps — that is text the user uploaded
 * which is unreachable by any query, and nothing downstream could detect it.
 */
function expectFullCoverage(text: string, chunks: DocumentChunk[]): void {
  const covered = new Uint8Array(text.length);
  for (const chunk of chunks) covered.fill(1, chunk.charStart, chunk.charEnd);

  const uncovered: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (!covered[i] && !/\s/.test(text[i])) {
      uncovered.push(`${i}: ${JSON.stringify(text.slice(i, i + 40))}`);
    }
  }

  expect(uncovered.slice(0, 5)).toEqual([]);
}

/* ========================================================================== *
 * TOKEN SIZES
 * ========================================================================== */

describe("chunk sizing", () => {
  it("packs chunks into the target band", () => {
    const text = document(
      ...Array.from({ length: 120 }, (_, i) => paragraph(i + 1)),
    );
    const chunks = chunkDocument({ text, pages: singlePage(text) });

    expect(chunks.length).toBeGreaterThan(5);
    expectChunkInvariants(text, chunks);

    // Every chunk's own content respects the ceiling; the stored token count
    // additionally carries the overlap, which is checked by the invariants.
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeGreaterThanOrEqual(CHUNKING.minTokens);
    }

    // The interior chunks — every chunk but the last, which is whatever the
    // document had left over — should sit near the target rather than
    // scattering across the whole legal range.
    const interior = chunks.slice(0, -1);
    for (const chunk of interior) {
      expect(chunk.tokenCount).toBeGreaterThan(CHUNKING.targetTokens * 0.6);
    }

    const mean =
      interior.reduce((sum, chunk) => sum + chunk.tokenCount, 0) /
      interior.length;
    expect(mean).toBeGreaterThan(CHUNKING.targetTokens * 0.85);
    expect(mean).toBeLessThan(
      CHUNKING.maxTokens +
        2 * Math.round(CHUNKING.targetTokens * CHUNKING.overlapRatio),
    );
  });

  it("honours a custom token budget", () => {
    const text = document(
      ...Array.from({ length: 40 }, (_, i) => paragraph(i + 1)),
    );
    const options: ChunkOptions = {
      targetTokens: 200,
      maxTokens: 260,
      minTokens: 40,
    };
    const chunks = chunkDocument({ text, pages: singlePage(text), options });

    expectChunkInvariants(text, chunks, options);
    // A smaller budget must produce more chunks — the parameter has to be load
    // bearing, not decorative.
    const wide = chunkDocument({ text, pages: singlePage(text) });
    expect(chunks.length).toBeGreaterThan(wide.length);
  });

  it("counts tokens with a real tokenizer, not a character estimate", () => {
    // Dense text where characters-over-four is badly wrong. If the chunker were
    // estimating, this would be indistinguishable from ordinary prose.
    const dense = "α β γ δ ε ζ η θ ι κ 中文字符 مرحبا שלום";
    const prose = "The quick brown fox jumps over the lazy dog every morning";

    expect(dense.length).toBeLessThan(prose.length);
    expect(countTokens(dense)).toBeGreaterThan(countTokens(prose));
  });

  it("does not throw on text containing a special-token literal", () => {
    // js-tiktoken's default `encode` rejects this string outright. A document
    // about language models is entitled to contain it.
    const text = document(
      ...Array.from({ length: 12 }, (_, i) => paragraph(i + 1)),
      "The sentinel <|endoftext|> marks the end of a training sequence.",
    );

    expect(() => countTokens(text)).not.toThrow();
    const chunks = chunkDocument({ text, pages: singlePage(text) });
    expectChunkInvariants(text, chunks);
    expect(chunks.map((chunk) => chunk.text).join(" ")).toContain(
      "<|endoftext|>",
    );
  });
});

/* ========================================================================== *
 * OVERLAP
 * ========================================================================== */

describe("overlap", () => {
  it("repeats real text from the end of the previous chunk", () => {
    const text = document(
      ...Array.from({ length: 60 }, (_, i) => paragraph(i + 1)),
    );
    const chunks = chunkDocument({ text, pages: singlePage(text) });
    expectChunkInvariants(text, chunks);
    expect(chunks.length).toBeGreaterThan(2);

    for (let i = 1; i < chunks.length; i += 1) {
      const previous = chunks[i - 1];
      const chunk = chunks[i];

      // The ranges genuinely intersect...
      expect(chunk.charStart).toBeLessThan(previous.charEnd);

      // ...and the shared range is the same text on both sides, which is what
      // makes the overlap useful rather than merely arithmetic.
      const shared = text.slice(chunk.charStart, previous.charEnd);
      expect(shared.length).toBeGreaterThan(0);
      expect(previous.text.endsWith(shared)).toBe(true);
      expect(chunk.text.startsWith(shared)).toBe(true);

      // Sized roughly as configured, and never the whole predecessor.
      expect(countTokens(shared)).toBeGreaterThanOrEqual(50);
      expect(countTokens(shared)).toBeLessThanOrEqual(
        2 * Math.round(CHUNKING.targetTokens * CHUNKING.overlapRatio),
      );
      expect(chunk.charStart).toBeGreaterThan(previous.charStart);
    }
  });

  it("produces no overlap when the ratio is zero", () => {
    const text = document(
      ...Array.from({ length: 60 }, (_, i) => paragraph(i + 1)),
    );
    const options: ChunkOptions = { overlapRatio: 0 };
    const chunks = chunkDocument({ text, pages: singlePage(text), options });

    expectChunkInvariants(text, chunks, options);
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i].charStart).toBeGreaterThanOrEqual(chunks[i - 1].charEnd);
    }
  });

  it("does not carry overlap across a section boundary", () => {
    // Two sections, each comfortably over the target, so the second chunk is
    // guaranteed to start on the second heading.
    const text = document(
      "## 1 Confidentiality",
      ...Array.from({ length: 30 }, (_, i) => paragraph(i + 1)),
      "## 2 Termination",
      ...Array.from({ length: 30 }, (_, i) => paragraph(i + 100)),
    );
    const chunks = chunkDocument({ text, pages: singlePage(text) });
    expectChunkInvariants(text, chunks);

    const opener = chunks.find((chunk) => chunk.text.startsWith("## 2 "));
    expect(opener).toBeDefined();

    // A chunk that opens a section starts exactly at its heading: nothing from
    // the previous section is dragged in.
    const previous = chunks[opener!.ordinal - 1];
    expect(opener!.charStart).toBeGreaterThanOrEqual(previous.charEnd);
    expect(opener!.text.startsWith("## 2 Termination")).toBe(true);
  });
});

/* ========================================================================== *
 * PAGES
 * ========================================================================== */

describe("page attribution", () => {
  it("reports a single page for a chunk that sits inside one", () => {
    const { text, pages } = paginate([
      document(...Array.from({ length: 20 }, (_, i) => paragraph(i + 1))),
      document(...Array.from({ length: 20 }, (_, i) => paragraph(i + 100))),
    ]);

    const chunks = chunkDocument({
      text,
      pages,
      // Small enough that chunks fit comfortably within a page.
      options: { targetTokens: 150, maxTokens: 200, minTokens: 40 },
    });

    const contained = chunks.filter(
      (chunk) =>
        chunk.charStart >= pages[0].charStart &&
        chunk.charEnd <= pages[0].charEnd,
    );
    expect(contained.length).toBeGreaterThan(0);
    for (const chunk of contained) {
      expect(chunk.pageFrom).toBe(1);
      expect(chunk.pageTo).toBe(1);
    }
  });

  it("spans page_from..page_to for a chunk straddling a page break", () => {
    // Each page is deliberately smaller than one chunk, so the middle chunks
    // must cross a break.
    const { text, pages } = paginate([
      document(paragraph(1), paragraph(2), paragraph(3)),
      document(paragraph(4), paragraph(5), paragraph(6)),
      document(paragraph(7), paragraph(8), paragraph(9)),
    ]);

    const chunks = chunkDocument({ text, pages });
    expectChunkInvariants(text, chunks);

    const straddling = chunks.filter((chunk) => chunk.pageTo > chunk.pageFrom);
    expect(straddling.length).toBeGreaterThan(0);

    // Independently re-derive the answer: which pages does this chunk's range
    // actually intersect? The chunker's binary search must agree with the
    // obvious linear computation.
    for (const chunk of chunks) {
      const touched = pages
        .filter(
          (page) =>
            page.charStart < chunk.charEnd && page.charEnd > chunk.charStart,
        )
        .map((page) => page.pageNumber);

      expect(chunk.pageFrom).toBe(Math.min(...touched));
      expect(chunk.pageTo).toBe(Math.max(...touched));
    }
  });

  it("resolves a boundary landing in the page separator to the content page", () => {
    // `assemblePages` joins pages with a blank line, so there are offsets that
    // belong to no page at all. A chunk starting there belongs to the page its
    // text is on, not the one that ended before it.
    const { text, pages } = paginate([
      document(paragraph(1), paragraph(2)),
      document(paragraph(3), paragraph(4)),
    ]);

    const chunks = chunkDocument({
      text,
      pages,
      options: { targetTokens: 120, maxTokens: 160, minTokens: 30 },
    });

    for (const chunk of chunks) {
      // Whatever the chunk's offsets, the reported pages must contain its text.
      const from = pages.find((page) => page.pageNumber === chunk.pageFrom);
      const to = pages.find((page) => page.pageNumber === chunk.pageTo);
      expect(from!.charEnd).toBeGreaterThan(chunk.charStart);
      expect(to!.charStart).toBeLessThan(chunk.charEnd);
    }
  });
});

/* ========================================================================== *
 * SECTION PATH
 * ========================================================================== */

describe("section path", () => {
  it("tracks nested markdown headings", () => {
    const text = document(
      "# Master Services Agreement",
      "## Article 7 - Termination",
      "### 7.1 For cause",
      ...Array.from({ length: 20 }, (_, i) => paragraph(i + 1)),
      "### 7.3 Termination for convenience",
      ...Array.from({ length: 20 }, (_, i) => paragraph(i + 100)),
    );
    const chunks = chunkDocument({ text, pages: singlePage(text) });
    expectChunkInvariants(text, chunks);

    expect(chunks[0].sectionPath).toBe(
      [
        "Master Services Agreement",
        "Article 7 - Termination",
        "7.1 For cause",
      ].join(SECTION_SEPARATOR),
    );

    const convenience = chunks.find((chunk) =>
      chunk.text.includes("### 7.3 Termination for convenience"),
    );
    expect(convenience!.sectionPath).toBe(
      [
        "Master Services Agreement",
        "Article 7 - Termination",
        "7.3 Termination for convenience",
      ].join(SECTION_SEPARATOR),
    );
  });

  it("pops sibling and deeper headings when a shallower one opens", () => {
    const text = document(
      "# Guideline",
      "## 1 Diagnosis",
      "### 1.1 Imaging",
      ...Array.from({ length: 14 }, (_, i) => paragraph(i + 1)),
      "## 2 Treatment",
      ...Array.from({ length: 14 }, (_, i) => paragraph(i + 100)),
    );
    const chunks = chunkDocument({ text, pages: singlePage(text) });

    const treatment = chunks.find((chunk) =>
      chunk.text.includes("## 2 Treatment"),
    );
    // "1 Diagnosis" and "1.1 Imaging" must both be gone from the breadcrumb.
    expect(treatment!.sectionPath).toBe(
      ["Guideline", "2 Treatment"].join(SECTION_SEPARATOR),
    );
  });

  it("uses the section of the chunk's first content, not its first heading", () => {
    // The chunk opens with three stacked headings. Reading the path off the
    // first would label the passage "Guideline" and throw away the two levels
    // that make a citation legible.
    const text = document(
      "# Guideline",
      "## 4 Dosing",
      "### 4.2 Renal impairment",
      ...Array.from({ length: 14 }, (_, i) => paragraph(i + 1)),
    );
    const chunks = chunkDocument({ text, pages: singlePage(text) });

    expect(chunks[0].text.startsWith("# Guideline")).toBe(true);
    expect(chunks[0].sectionPath).toBe(
      ["Guideline", "4 Dosing", "4.2 Renal impairment"].join(SECTION_SEPARATOR),
    );
  });

  it("finds numbered clause headings in text with no markdown markers", () => {
    // What a PDF contract looks like after extraction: no `#`, just short lines
    // that are headings and long ones that are not.
    const text = document(
      "ARTICLE 7 - TERMINATION",
      "7.1 Termination for cause",
      ...Array.from({ length: 14 }, (_, i) => paragraph(i + 1)),
      "7.2 Termination for convenience",
      ...Array.from({ length: 14 }, (_, i) => paragraph(i + 100)),
    );
    const chunks = chunkDocument({ text, pages: singlePage(text) });
    expectChunkInvariants(text, chunks);

    expect(chunks[0].sectionPath).toBe(
      ["ARTICLE 7 - TERMINATION", "7.1 Termination for cause"].join(
        SECTION_SEPARATOR,
      ),
    );

    const second = chunks.find((chunk) =>
      chunk.text.includes("7.2 Termination for convenience"),
    );
    // 7.2 replaces 7.1 rather than nesting under it: same numbering depth.
    expect(second!.sectionPath).toBe(
      ["ARTICLE 7 - TERMINATION", "7.2 Termination for convenience"].join(
        SECTION_SEPARATOR,
      ),
    );
  });

  it("ends a chunk at a heading rather than spanning sections", () => {
    // The default is structure-first: as long as the running chunk clears the
    // floor, a heading closes it. So a heading may appear at the START of a
    // chunk but never in the middle of one — which is what makes the recorded
    // section_path true for the whole chunk rather than for its first line.
    const text = document(
      ...[1, 2, 3, 4].flatMap((section) => [
        `## ${section} Section ${section}`,
        ...Array.from({ length: 12 }, (_, i) => paragraph(section * 100 + i)),
      ]),
    );
    const chunks = chunkDocument({ text, pages: singlePage(text) });
    expectChunkInvariants(text, chunks);

    for (const chunk of chunks) {
      const body = chunk.text.slice(1);
      expect(body).not.toMatch(/\n## \d Section/);
    }

    // And the breadcrumb genuinely names the section the body sits in.
    for (const chunk of chunks) {
      const section = /paragraph (\d)\d\d /.exec(chunk.text)![1];
      expect(chunk.sectionPath).toBe(`${section} Section ${section}`);
    }
  });

  it("packs across headings when sectionBreakRatio is raised", () => {
    const text = document(
      ...[1, 2, 3, 4].flatMap((section) => [
        `## ${section} Section ${section}`,
        ...Array.from({ length: 4 }, (_, i) => paragraph(section * 100 + i)),
      ]),
    );

    const structural = chunkDocument({ text, pages: singlePage(text) });
    const packed = chunkDocument({
      text,
      pages: singlePage(text),
      options: { sectionBreakRatio: 1 },
    });

    // The knob has to actually move something, or it is decoration.
    expect(packed.length).toBeLessThan(structural.length);
    expect(structural.length).toBe(4);
    // Each structural chunk is exactly one section; the packed ones are not.
    expect(structural.map((chunk) => chunk.sectionPath)).toEqual([
      "1 Section 1",
      "2 Section 2",
      "3 Section 3",
      "4 Section 4",
    ]);
  });

  it("is null for a document with no headings", () => {
    const text = document(
      ...Array.from({ length: 14 }, (_, i) => paragraph(i + 1)),
    );
    const chunks = chunkDocument({ text, pages: singlePage(text) });
    for (const chunk of chunks) expect(chunk.sectionPath).toBeNull();
  });

  it("does not mistake a wrapped paragraph's first line for a heading", () => {
    // The danger case for every heuristic here: prose that begins with
    // something heading-shaped. All three of these are ordinary sentences.
    const text = document(
      "7. The Provider shall deliver the goods within thirty days of the order,",
      "Section 4 of the Agreement provides that the Customer may inspect the goods on delivery and reject them,",
      ...Array.from({ length: 14 }, (_, i) => paragraph(i + 1)),
    );
    const chunks = chunkDocument({ text, pages: singlePage(text) });
    for (const chunk of chunks) expect(chunk.sectionPath).toBeNull();
  });

  it("can be told to ignore ALL-CAPS lines", () => {
    // A running header repeated on every page of a PDF is the reason this
    // switch exists.
    const text = document(
      "CONFIDENTIAL - DRAFT",
      ...Array.from({ length: 14 }, (_, i) => paragraph(i + 1)),
    );

    const detected = chunkDocument({ text, pages: singlePage(text) });
    expect(detected[0].sectionPath).toBe("CONFIDENTIAL - DRAFT");

    const ignored = chunkDocument({
      text,
      pages: singlePage(text),
      options: { detectAllCapsHeadings: false },
    });
    expect(ignored[0].sectionPath).toBeNull();
  });

  it("truncates a very deep breadcrumb from the left", () => {
    const deep = document(
      "# " + "Alpha".repeat(20),
      "## " + "Bravo".repeat(20),
      "### " + "Charlie".repeat(20),
      "#### Leaf section",
      ...Array.from({ length: 14 }, (_, i) => paragraph(i + 1)),
    );
    const chunks = chunkDocument({ text: deep, pages: singlePage(deep) });

    // The chunk holding the leaf section's body, not simply the first chunk:
    // the three outer headings are long enough to fill a chunk of their own.
    const leaf = chunks.find((chunk) => chunk.text.includes("#### Leaf"))!;
    const path = leaf.sectionPath!;

    expect(path.length).toBeLessThanOrEqual(CHUNKING.maxSectionPathChars + 40);
    // The leaf survives; the ancestors are what get dropped.
    expect(path.endsWith("Leaf section")).toBe(true);
    expect(path.startsWith("…")).toBe(true);
  });
});

/* ========================================================================== *
 * THE SPLIT HIERARCHY
 * ========================================================================== */

describe("split hierarchy", () => {
  it("prefers paragraph boundaries over sentence boundaries", () => {
    const text = document(
      ...Array.from({ length: 40 }, (_, i) => paragraph(i + 1)),
    );
    const chunks = chunkDocument({ text, pages: singlePage(text) });

    // Every chunk begins at the start of a paragraph and ends at the end of
    // one: nothing was cut mid-paragraph while whole paragraphs were available.
    for (const chunk of chunks) {
      expect(chunk.text.startsWith("This is paragraph ")).toBe(true);
      expect(chunk.text.endsWith("set out in Schedule A.")).toBe(true);
    }
  });

  it("falls to sentences for a paragraph larger than the budget", () => {
    // One paragraph, no blank lines, far over the budget.
    const sentences = Array.from(
      { length: 60 },
      (_, i) =>
        `Clause ${i + 1} provides that the receiving party shall protect the ` +
        `disclosing party's confidential information with reasonable care.`,
    );
    const text = sentences.join(" ");
    const chunks = chunkDocument({ text, pages: singlePage(text) });

    expect(chunks.length).toBeGreaterThan(1);
    expectChunkInvariants(text, chunks);

    // Each chunk is a whole number of sentences: it ends on a full stop and
    // starts on a capital.
    for (const chunk of chunks) {
      expect(chunk.text.endsWith(".")).toBe(true);
      expect(chunk.text.startsWith("Clause ")).toBe(true);
    }
  });

  it("hard-splits only when a single sentence exceeds the budget", () => {
    // No sentence-ending punctuation anywhere: the last resort.
    const text = Array.from({ length: 2000 }, (_, i) => `token${i}`).join(" ");
    const chunks = chunkDocument({ text, pages: singlePage(text) });

    expect(chunks.length).toBeGreaterThan(1);
    expectChunkInvariants(text, chunks);
    // The cut lands between words, never inside one.
    for (const chunk of chunks) {
      expect(chunk.text).toMatch(/^token\d+/);
      expect(chunk.text).toMatch(/token\d+$/);
    }
  });

  it("does not split a sentence at an abbreviation", () => {
    // Each of these periods would end a sentence for a naive splitter, putting
    // a dosage or a cross-reference on the wrong side of a chunk boundary.
    const tricky =
      `Dr. Alvarez confirmed the finding. The dose is 5 mg. Twice daily is ` +
      `standard, see Art. 7 below. Compare No. 14 and Fig. 3 in the appendix. ` +
      `The trial ran to 2019. Results were published in the U.S. Later work ` +
      `by J. Okafor et al. replicated it.`;
    const text = Array.from({ length: 12 }, () => tricky).join(" ");

    const chunks = chunkDocument({
      text,
      pages: singlePage(text),
      options: { targetTokens: 90, maxTokens: 120, minTokens: 20 },
    });

    expectChunkInvariants(text, chunks, {
      targetTokens: 90,
      maxTokens: 120,
      minTokens: 20,
    });

    // No chunk may begin at one of the abbreviation-internal breaks.
    for (const chunk of chunks) {
      expect(chunk.text).not.toMatch(/^Twice daily/);
      expect(chunk.text).not.toMatch(/^Alvarez/);
      expect(chunk.text).not.toMatch(/^7 below/);
      expect(chunk.text).not.toMatch(/^3 in the appendix/);
      expect(chunk.text).not.toMatch(/^Okafor/);
      expect(chunk.text).not.toMatch(/^Later work/);
    }
  });

  it("does not treat a numbered list marker as a sentence end", () => {
    // The items end in real full stops, so the sentence splitter is genuinely
    // in play: the only periods it must NOT break on are the list markers.
    const list = Array.from(
      { length: 40 },
      (_, i) =>
        `${i + 1}. The Provider shall perform the services described in the ` +
        `applicable statement of work with reasonable skill and care.`,
    ).join("\n");

    const chunks = chunkDocument({ text: list, pages: singlePage(list) });
    expectChunkInvariants(list, chunks);
    expect(chunks.length).toBeGreaterThan(1);

    // Every chunk begins with a whole list item, number attached. A break after
    // the marker would leave "The Provider shall..." with no clause number —
    // exactly the citation that cannot be traced back to the contract.
    for (const chunk of chunks) {
      expect(chunk.text).toMatch(/^\d+\. The Provider shall perform/);
      expect(chunk.text.endsWith("care.")).toBe(true);
    }
  });
});

/* ========================================================================== *
 * THE MINIMUM
 * ========================================================================== */

describe("the minimum chunk size", () => {
  it("merges a short trailing chunk into its neighbour", () => {
    // Sized so the document ends just past a chunk boundary, leaving a runt.
    const text = document(
      ...Array.from({ length: 13 }, (_, i) => paragraph(i + 1)),
      "One final sentence.",
    );
    const chunks = chunkDocument({ text, pages: singlePage(text) });

    expectChunkInvariants(text, chunks);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeGreaterThanOrEqual(CHUNKING.minTokens);
    }
    // The stray sentence is still in the corpus, attached to the chunk above it.
    expect(chunks[chunks.length - 1].text).toContain("One final sentence.");
  });

  it("keeps a whole document that is shorter than the minimum", () => {
    // Refusing to index a two-line document would be worse than a short chunk.
    const text = "A short note. That is all there is.";
    const chunks = chunkDocument({ text, pages: singlePage(text) });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(text);
    expect(chunks[0].tokenCount).toBeLessThan(CHUNKING.minTokens);
    expectFullCoverage(text, chunks);
  });

  it("does not emit a fragment for a section with almost no body", () => {
    const text = document(
      "## 1 Definitions",
      "Not applicable.",
      "## 2 Scope",
      ...Array.from({ length: 14 }, (_, i) => paragraph(i + 1)),
    );
    const chunks = chunkDocument({ text, pages: singlePage(text) });

    expectChunkInvariants(text, chunks);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeGreaterThanOrEqual(CHUNKING.minTokens);
    }
  });
});

/* ========================================================================== *
 * THE CONTEXT HEADER
 * ========================================================================== */

describe("embeddingText", () => {
  it("prepends the title and section path", () => {
    const chunk = {
      text: "The period is thirty (30) days.",
      sectionPath: "Article 7 › 7.3 Termination",
    };

    expect(embeddingText(chunk, "Master Services Agreement")).toBe(
      "Master Services Agreement — Article 7 › 7.3 Termination\n\n" +
        "The period is thirty (30) days.",
    );
  });

  it("falls back cleanly when either half is missing", () => {
    expect(embeddingText({ text: "Body.", sectionPath: null }, "Title")).toBe(
      "Title\n\nBody.",
    );
    expect(embeddingText({ text: "Body.", sectionPath: "7.3" }, "  ")).toBe(
      "7.3\n\nBody.",
    );
    expect(embeddingText({ text: "Body.", sectionPath: null }, "")).toBe(
      "Body.",
    );
  });

  it("leaves the stored text untouched", () => {
    // The header is for the embedder only. If it leaked into `chunk.text` the
    // citation panel would show it, the lexical index would be stuffed with the
    // same heading forty times, and the highlight offsets would no longer line
    // up with the page.
    const text = document(
      "# Agreement",
      "## 7 Termination",
      ...Array.from({ length: 14 }, (_, i) => paragraph(i + 1)),
    );
    const chunks = chunkDocument({ text, pages: singlePage(text) });

    for (const chunk of chunks) {
      const augmented = embeddingText(chunk, "Agreement.pdf");
      expect(augmented).toContain(chunk.text);
      expect(augmented.length).toBeGreaterThan(chunk.text.length);
      // The stored text is still exactly what the document says.
      expect(text.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text);
      expect(chunk.text).not.toContain("Agreement.pdf — ");
    }
  });
});

/* ========================================================================== *
 * EDGES
 * ========================================================================== */

describe("edge cases", () => {
  it("returns nothing for an empty or blank document", () => {
    expect(chunkDocument({ text: "", pages: [] })).toEqual([]);
    expect(chunkDocument({ text: "   \n\n  \t\n", pages: [] })).toEqual([]);
  });

  it("handles a document with no pages recorded", () => {
    const text = document(
      ...Array.from({ length: 14 }, (_, i) => paragraph(i + 1)),
    );
    const chunks = chunkDocument({ text, pages: [] });

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.pageFrom).toBe(1);
      expect(chunk.pageTo).toBe(1);
    }
  });

  it("handles a document that is one heading and nothing else", () => {
    const text = "# Appendix C";
    const chunks = chunkDocument({ text, pages: singlePage(text) });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("# Appendix C");
    expect(chunks[0].sectionPath).toBe("Appendix C");
  });

  it("preserves unicode exactly through the offset arithmetic", () => {
    // Em dashes, ligatures, CJK, and RTL all have to survive the slice, since
    // JavaScript string offsets are UTF-16 code units and not characters.
    const exotic = document(
      ...Array.from(
        { length: 14 },
        (_, i) =>
          `Section ${i + 1} — the ﬁrst clause covers 中文字符 and مرحبا ` +
          `alongside ordinary prose about the delivery of the services.`,
      ),
    );
    const chunks = chunkDocument({ text: exotic, pages: singlePage(exotic) });

    expectChunkInvariants(exotic, chunks);
    expect(chunks.some((chunk) => chunk.text.includes("中文字符"))).toBe(true);
  });

  it("chunks a realistic mixed document end to end", () => {
    const { text, pages } = paginate([
      document(
        "# Clinical Practice Guideline",
        "## 1 Scope",
        ...Array.from({ length: 6 }, (_, i) => paragraph(i + 1)),
      ),
      document(
        "## 2 Diagnosis",
        "### 2.1 Imaging",
        ...Array.from({ length: 8 }, (_, i) => paragraph(i + 100)),
      ),
      document(
        "### 2.2 Laboratory tests",
        ...Array.from({ length: 8 }, (_, i) => paragraph(i + 200)),
        "## 3 Treatment",
        ...Array.from({ length: 8 }, (_, i) => paragraph(i + 300)),
      ),
    ]);

    const chunks = chunkDocument({ text, pages });

    expectChunkInvariants(text, chunks);
    expect(chunks.length).toBeGreaterThan(2);
    // Every chunk knows where it is and which page to scroll to.
    for (const chunk of chunks) {
      expect(chunk.sectionPath).not.toBeNull();
      expect(chunk.pageFrom).toBeGreaterThanOrEqual(1);
      expect(chunk.pageTo).toBeLessThanOrEqual(pages.length);
    }
  });
});
