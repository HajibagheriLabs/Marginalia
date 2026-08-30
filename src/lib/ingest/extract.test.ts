import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ExtractionError,
  MIN_CHARS_PER_PAGE,
  PAGE_SEPARATOR,
  assemblePages,
  describePdfFailure,
  docxHtmlToText,
  extractDocument,
  normalizePdfText,
  normalizeSourceText,
  paginateText,
  sniffFormat,
  type ExtractionResult,
} from "./extract";
import { buildCorruptPdf, buildPdf } from "./__fixtures__/build-pdf";
import { buildDocx } from "./__fixtures__/build-docx";

const utf8 = (value: string) => new Uint8Array(Buffer.from(value, "utf8"));

const markdownFixture = readFileSync(
  new URL("./__fixtures__/sample.md", import.meta.url),
  "utf8",
);

/**
 * THE OFFSET GUARANTEE, asserted the same way for every format.
 *
 * Slicing the concatenated document text with a page's char_start/char_end must
 * reproduce that page's text exactly. Everything downstream — chunk offsets,
 * citation ranges, the viewer's highlight — is built on this identity holding
 * for every page of every document, so it is checked in every extraction test
 * rather than in one test of its own.
 */
function expectOffsetsRoundTrip(result: ExtractionResult): void {
  expect(result.pages).not.toHaveLength(0);
  expect(result.pageCount).toBe(result.pages.length);

  result.pages.forEach((page, index) => {
    expect(page.pageNumber).toBe(index + 1);
    expect(result.text.slice(page.charStart, page.charEnd)).toBe(page.text);
    expect(page.charEnd).toBeGreaterThanOrEqual(page.charStart);
    expect(page.charEnd).toBeLessThanOrEqual(result.text.length);
  });

  // Pages appear in order, never overlap, and the first starts at zero.
  expect(result.pages[0].charStart).toBe(0);
  for (let i = 1; i < result.pages.length; i += 1) {
    expect(result.pages[i].charStart).toBeGreaterThanOrEqual(
      result.pages[i - 1].charEnd,
    );
  }
  const last = result.pages[result.pages.length - 1];
  expect(last.charEnd).toBe(result.text.length);
}

/* ========================================================================== *
 * The invariant itself
 * ========================================================================== */

describe("assemblePages", () => {
  it("round-trips every page through the concatenated text", () => {
    const inputs = [
      ["only page"],
      ["first", "second", "third"],
      ["has\nnewlines", "", "trailing"],
      ["", ""],
      ["unicode — em dashes, ligatures ﬁ, and 中文", "second"],
    ];

    for (const pageTexts of inputs) {
      const { text, pages } = assemblePages(pageTexts);
      expect(pages).toHaveLength(pageTexts.length);
      pages.forEach((page, index) => {
        expect(text.slice(page.charStart, page.charEnd)).toBe(pageTexts[index]);
      });
    }
  });

  it("separates pages with exactly one blank line", () => {
    const { text } = assemblePages(["a", "b"]);
    expect(text).toBe(`a${PAGE_SEPARATOR}b`);
  });

  it("returns empty text and no pages for no input", () => {
    expect(assemblePages([])).toEqual({ text: "", pages: [] });
  });

  it("keeps offsets correct when a page is empty", () => {
    const { text, pages } = assemblePages(["alpha", "", "omega"]);
    expect(pages[1].charStart).toBe(pages[1].charEnd);
    expect(text.slice(pages[2].charStart, pages[2].charEnd)).toBe("omega");
  });
});

/* ========================================================================== *
 * Normalization
 * ========================================================================== */

describe("normalizePdfText", () => {
  it("collapses runs of spaces and tabs without touching newlines", () => {
    expect(normalizePdfText("a    b\t\tc")).toBe("a b c");
    expect(normalizePdfText("line one\nline two")).toBe("line one\nline two");
  });

  it("does not reflow paragraphs", () => {
    // The single newlines inside a paragraph survive. Joining them would make
    // the stored text unrecognisable against the rendered page.
    const input = "The parties agree\nthat termination requires\nwritten notice.";
    expect(normalizePdfText(input)).toBe(input);
  });

  it("rejoins a word broken across a line by hyphenation", () => {
    expect(normalizePdfText("termi-\nnation")).toBe("termination");
    expect(normalizePdfText("obli-\ngations accrued")).toBe("obligations accrued");
  });

  it("leaves a hyphen alone when the next line starts a new sentence", () => {
    expect(normalizePdfText("thirty-\nDays")).toBe("thirty-\nDays");
  });

  it("drops soft hyphens and zero-width characters", () => {
    expect(normalizePdfText("ter\u00ADmination")).toBe("termination");
    expect(normalizePdfText("a\u200Bb\uFEFFc")).toBe("abc");
  });

  it("normalizes line endings and caps blank runs at one blank line", () => {
    expect(normalizePdfText("a\r\nb")).toBe("a\nb");
    expect(normalizePdfText("a\n\n\n\n\nb")).toBe("a\n\nb");
  });

  it("trims trailing spaces from each line", () => {
    expect(normalizePdfText("a   \n   b")).toBe("a\nb");
  });
});

describe("normalizeSourceText", () => {
  it("preserves leading indentation", () => {
    // Indentation carries meaning in Markdown: code blocks and nested lists.
    expect(normalizeSourceText("- item\n    - nested")).toBe("- item\n    - nested");
  });

  it("preserves markdown heading markers", () => {
    expect(normalizeSourceText("## 7. Termination")).toBe("## 7. Termination");
  });

  it("strips control characters that would break a Postgres text column", () => {
    expect(normalizeSourceText("a\u0000b\u0007c")).toBe("abc");
    expect(normalizeSourceText("keep\tthe\ttabs")).toBe("keep\tthe\ttabs");
  });

  it("caps blank runs at one blank line", () => {
    expect(normalizeSourceText("a\n\n\n\nb")).toBe("a\n\nb");
  });
});

/* ========================================================================== *
 * Pagination for formats with no pages
 * ========================================================================== */

describe("paginateText", () => {
  it("keeps a short document as one page", () => {
    expect(paginateText("short enough", 3000)).toEqual(["short enough"]);
  });

  it("splits on paragraph boundaries and reconstructs the source exactly", () => {
    const paragraphs = Array.from(
      { length: 40 },
      (_unused, index) => `Paragraph ${index}. ${"word ".repeat(20).trim()}`,
    );
    const source = paragraphs.join(PAGE_SEPARATOR);

    const pages = paginateText(source, 600);

    expect(pages.length).toBeGreaterThan(1);
    // The join is what defines the document text, and for paragraph-splittable
    // input it is byte-identical to the source.
    expect(pages.join(PAGE_SEPARATOR)).toBe(source);
    // No paragraph was cut in half.
    for (const page of pages) {
      expect(page.startsWith("Paragraph ")).toBe(true);
    }
  });

  it("breaks a single oversized paragraph at a word boundary", () => {
    const paragraph = "word ".repeat(400).trim(); // 1999 characters, no blank line
    const pages = paginateText(paragraph, 500);

    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page.length).toBeLessThanOrEqual(500);
      expect(page.startsWith(" ")).toBe(false);
      expect(page.endsWith(" ")).toBe(false);
    }
    // Nothing was dropped, even though the rejoin inserts a blank line that the
    // source did not have.
    expect(pages.join(" ").replace(/\s+/g, " ")).toBe(paragraph);
  });
});

/* ========================================================================== *
 * Format sniffing
 * ========================================================================== */

describe("sniffFormat", () => {
  it("recognises a PDF, a ZIP, text, and binary", () => {
    expect(sniffFormat(buildPdf([{ blocks: [] }]))).toBe("pdf");
    expect(sniffFormat(buildDocx([{ kind: "paragraph", text: "hi" }]))).toBe("zip");
    expect(sniffFormat(utf8("plain text"))).toBe("text");
    expect(sniffFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))).toBe(
      "binary",
    );
  });
});

/* ========================================================================== *
 * PDF
 * ========================================================================== */

/** Enough text per page to clear the scanned-document threshold. */
const BODY_LINES = [
  "Either party may terminate this Agreement for convenience upon sixty",
  "(60) days prior written notice to the other party. Termination shall not",
  "relieve either party of obligations accrued prior to the effective date.",
];

describe("PDF extraction", () => {
  it("extracts a normal two-page text PDF", async () => {
    const pdf = buildPdf([
      { blocks: [{ x: 72, y: 720, lines: ["7. Termination", ...BODY_LINES] }] },
      { blocks: [{ x: 72, y: 720, lines: ["8. Confidentiality", ...BODY_LINES] }] },
    ]);

    const result = await extractDocument({
      data: pdf,
      filename: "agreement.pdf",
      mimeType: "application/pdf",
    });

    expect(result.pageCount).toBe(2);
    expect(result.pages).toHaveLength(2);
    expect(result.pageBoundaries).toBe("physical");
    expect(result.ocrUsed).toBe(false);

    expect(result.pages[0].text).toContain("7. Termination");
    expect(result.pages[0].text).toContain("sixty");
    expect(result.pages[1].text).toContain("8. Confidentiality");
    // Page 2's content must not have leaked into page 1.
    expect(result.pages[0].text).not.toContain("Confidentiality");

    expectOffsetsRoundTrip(result);
  });

  it("extracts both columns of a two-column PDF", async () => {
    // Reading order for a multi-column PDF follows the content stream, which is
    // what PDF.js reports and what a layout-aware pass would later reorder.
    // What must hold today is that no text is lost and the offsets are sound.
    const pdf = buildPdf([
      {
        blocks: [
          {
            x: 60,
            y: 720,
            lines: [
              "LEFT COLUMN. The Supplier shall provide the Services with",
              "reasonable skill and care, in accordance with the Specification",
              "and any applicable service levels set out in the Order Form.",
            ],
          },
          {
            x: 320,
            y: 720,
            lines: [
              "RIGHT COLUMN. The Customer shall provide such access, data and",
              "cooperation as the Supplier reasonably requires, and shall obtain",
              "all consents necessary for the Supplier to perform the Services.",
            ],
          },
        ],
      },
    ]);

    const result = await extractDocument({
      data: pdf,
      filename: "two-column.pdf",
      mimeType: "application/pdf",
    });

    expect(result.pageCount).toBe(1);
    expect(result.pages[0].text).toContain("LEFT COLUMN");
    expect(result.pages[0].text).toContain("RIGHT COLUMN");
    expect(result.pages[0].text).toContain("reasonable skill and care");
    expect(result.pages[0].text).toContain("consents necessary");

    expectOffsetsRoundTrip(result);
  });

  it("refuses a scanned PDF instead of indexing an empty document", async () => {
    // Three pages, no text operators at all — what a scan looks like to a
    // parser: real pages, no text layer.
    const pdf = buildPdf([{ blocks: [] }, { blocks: [] }, { blocks: [] }]);

    await expect(
      extractDocument({
        data: pdf,
        filename: "scan.pdf",
        mimeType: "application/pdf",
      }),
    ).rejects.toMatchObject({
      code: "no_text_layer",
      message:
        "This PDF has no selectable text — it looks like a scan. OCR isn't supported yet.",
    });
  });

  it("refuses a PDF whose text falls below the per-page threshold", async () => {
    // Two pages carrying a handful of characters each: a cover sheet and a
    // page number, which is not a document anyone can ask questions about.
    const pdf = buildPdf([
      { blocks: [{ x: 72, y: 720, lines: ["Cover"] }] },
      { blocks: [{ x: 72, y: 720, lines: ["2"] }] },
    ]);

    await expect(
      extractDocument({
        data: pdf,
        filename: "cover.pdf",
        mimeType: "application/pdf",
      }),
    ).rejects.toMatchObject({ code: "no_text_layer" });
  });

  it("accepts a document whose average clears the threshold despite a blank page", async () => {
    const long = Array.from(
      { length: 6 },
      () => "The Processor shall implement appropriate technical measures.",
    );
    const pdf = buildPdf([
      { blocks: [{ x: 72, y: 720, lines: long }] },
      { blocks: [] }, // a section divider
      { blocks: [{ x: 72, y: 720, lines: long }] },
    ]);

    const result = await extractDocument({
      data: pdf,
      filename: "with-divider.pdf",
      mimeType: "application/pdf",
    });

    expect(result.pageCount).toBe(3);
    expect(result.pages[1].text).toBe("");
    expectOffsetsRoundTrip(result);
  });

  it("uses an OCR provider when one is supplied", async () => {
    const pdf = buildPdf([{ blocks: [] }, { blocks: [] }]);
    const recognized =
      "Recognized text standing in for a scanned page, written long enough to clear the hundred-character-per-page threshold comfortably.";

    const result = await extractDocument({
      data: pdf,
      filename: "scan.pdf",
      mimeType: "application/pdf",
      ocr: {
        name: "test-ocr",
        async recognizePages({ pageNumbers }) {
          expect(pageNumbers).toEqual([1, 2]);
          return new Map(pageNumbers.map((page) => [page, recognized]));
        },
      },
    });

    expect(result.ocrUsed).toBe(true);
    expect(result.pages[0].text).toBe(recognized);
    expectOffsetsRoundTrip(result);
  });

  it("names the damage when a PDF cannot be parsed", async () => {
    await expect(
      extractDocument({
        data: buildCorruptPdf(),
        filename: "broken.pdf",
        mimeType: "application/pdf",
      }),
    ).rejects.toMatchObject({ code: "corrupt" });
  });

  it("refuses a PDF with no pages", async () => {
    await expect(
      extractDocument({
        data: buildPdf([], { noPages: true }),
        filename: "empty.pdf",
        mimeType: "application/pdf",
      }),
    ).rejects.toBeInstanceOf(ExtractionError);
  });

  it("maps PDF.js exceptions onto specific messages", () => {
    // Manufacturing a genuinely encrypted PDF means implementing the standard
    // security handler; testing the mapping directly is both cheaper and a
    // better test of the branch that actually runs.
    const password = describePdfFailure(
      Object.assign(new Error("No password given"), {
        name: "PasswordException",
      }),
    );
    expect(password.code).toBe("encrypted");
    expect(password.message).toContain("password-protected");

    const missing = describePdfFailure(
      Object.assign(new Error("Missing PDF"), { name: "MissingPDFException" }),
    );
    expect(missing.code).toBe("corrupt");
    expect(missing.message).toContain("truncated");

    const invalid = describePdfFailure(
      Object.assign(new Error("Invalid PDF structure"), {
        name: "InvalidPDFException",
      }),
    );
    expect(invalid.code).toBe("corrupt");
    expect(invalid.message).toContain("structure is damaged");

    // Even the fallback names the operation rather than shrugging.
    const unknown = describePdfFailure(new Error("something else"));
    expect(unknown.code).toBe("corrupt");
    expect(unknown.message).toContain("could not be parsed");
  });
});

/* ========================================================================== *
 * Type mismatches — the extension is a claim, not a fact
 * ========================================================================== */

describe("type mismatches", () => {
  it("names DOCX when a ZIP arrives with a .pdf extension", async () => {
    await expect(
      extractDocument({
        data: buildDocx([{ kind: "paragraph", text: "hello" }]),
        filename: "renamed.pdf",
        mimeType: "application/pdf",
      }),
    ).rejects.toMatchObject({
      code: "type_mismatch",
      message: expect.stringContaining("ZIP archive"),
    });
  });

  it("names PDF when a PDF arrives with a .docx extension", async () => {
    await expect(
      extractDocument({
        data: buildPdf([{ blocks: [{ x: 72, y: 720, lines: BODY_LINES }] }]),
        filename: "renamed.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ).rejects.toMatchObject({
      code: "type_mismatch",
      message: expect.stringContaining("a PDF"),
    });
  });

  it("refuses an unsupported extension by name", async () => {
    await expect(
      extractDocument({
        data: utf8("anything"),
        filename: "notes.rtf",
        mimeType: "text/plain",
      }),
    ).rejects.toMatchObject({ code: "unsupported_type" });
  });

  it("refuses an empty file", async () => {
    await expect(
      extractDocument({
        data: new Uint8Array(0),
        filename: "notes.txt",
        mimeType: "text/plain",
      }),
    ).rejects.toMatchObject({ code: "empty_document" });
  });
});

/* ========================================================================== *
 * Markdown and plain text
 * ========================================================================== */

describe("markdown extraction", () => {
  it("preserves heading structure for the chunker", async () => {
    const result = await extractDocument({
      data: utf8(markdownFixture),
      filename: "dpa.md",
      mimeType: "text/markdown",
    });

    expect(result.pageBoundaries).toBe("synthetic");
    expect(result.pageCount).toBe(1);

    // The markers survive verbatim: the structure-aware chunker splits on them
    // and builds the section breadcrumb a citation is labelled with.
    expect(result.text).toContain("# Data Processing Addendum");
    expect(result.text).toContain("## 2. Scope of processing");
    expect(result.text).toContain("### 2.1 Duration");
    expect(result.text).toContain("- \"Personal data\" has the meaning");

    expectOffsetsRoundTrip(result);
  });

  it("splits a long markdown file into synthetic pages", async () => {
    const long = Array.from(
      { length: 30 },
      (_unused, index) =>
        `## Section ${index}\n\nThe Processor shall implement appropriate technical and organisational measures to ensure a level of security appropriate to the risk.`,
    ).join("\n\n");

    const result = await extractDocument({
      data: utf8(long),
      filename: "long.md",
      mimeType: "text/markdown",
    });

    expect(result.pageCount).toBeGreaterThan(1);
    expect(result.pageBoundaries).toBe("synthetic");
    // Nothing was lost or reordered on the way through pagination.
    expect(result.text).toBe(normalizeSourceText(long));
    expectOffsetsRoundTrip(result);
  });

  it("extracts a plain text file", async () => {
    const result = await extractDocument({
      data: utf8("First paragraph.\n\nSecond paragraph.\n"),
      filename: "notes.txt",
      mimeType: "text/plain",
    });

    expect(result.pageCount).toBe(1);
    expect(result.text).toBe("First paragraph.\n\nSecond paragraph.");
    expectOffsetsRoundTrip(result);
  });
});

/* ========================================================================== *
 * DOCX
 * ========================================================================== */

describe("DOCX extraction", () => {
  it("carries heading structure through as markdown markers", async () => {
    const docx = buildDocx([
      { kind: "heading", level: 1, text: "Employee Handbook" },
      { kind: "paragraph", text: "This handbook describes company policy." },
      { kind: "heading", level: 2, text: "Working hours" },
      {
        kind: "paragraph",
        text: "Standard hours are 09:00 to 17:30, Monday to Friday.",
      },
    ]);

    const result = await extractDocument({
      data: docx,
      filename: "handbook.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    expect(result.pageBoundaries).toBe("synthetic");
    expect(result.text).toContain("# Employee Handbook");
    expect(result.text).toContain("## Working hours");
    expect(result.text).toContain("Standard hours are 09:00 to 17:30");

    expectOffsetsRoundTrip(result);
  });

  it("refuses a DOCX with no text", async () => {
    await expect(
      extractDocument({
        data: buildDocx([]),
        filename: "blank.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ).rejects.toMatchObject({ code: "empty_document" });
  });
});

describe("docxHtmlToText", () => {
  it("maps mammoth's tag vocabulary onto markdown", () => {
    const html =
      "<h1>Title</h1><p>Body <strong>text</strong>.</p><ul><li>one</li><li>two</li></ul>";
    const text = normalizeSourceText(docxHtmlToText(html));

    expect(text).toContain("# Title");
    expect(text).toContain("Body text.");
    expect(text).toContain("- one");
    expect(text).toContain("- two");
    // No markup survives into the indexed text.
    expect(text).not.toContain("<");
  });

  it("decodes the entities mammoth emits", () => {
    expect(docxHtmlToText("<p>Tom &amp; Jerry &lt;tag&gt;</p>")).toContain(
      "Tom & Jerry <tag>",
    );
  });
});

/* ========================================================================== *
 * The threshold constant is part of the contract
 * ========================================================================== */

describe("scanned-document threshold", () => {
  it("is documented as roughly 100 characters per page", () => {
    expect(MIN_CHARS_PER_PAGE).toBe(100);
  });
});
