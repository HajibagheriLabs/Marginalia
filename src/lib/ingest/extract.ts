import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";

/**
 * STAGE 1 OF INGESTION: TEXT EXTRACTION.
 *
 * Turns an uploaded file into a list of pages and one concatenated document
 * text. It does not chunk, does not embed, and does not touch the database —
 * that is `extract-stage.ts`, which calls this and persists the result. Keeping
 * the extraction itself pure is what makes it testable against real files
 * without a Postgres connection.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE OFFSET GUARANTEE
 *
 * For every page this module returns:
 *
 *     result.text.slice(page.charStart, page.charEnd) === page.text
 *
 * That identity is the foundation the rest of the pipeline stands on. Chunks
 * record char_start/char_end into the same concatenated text; a citation
 * resolves to a chunk, a chunk resolves to a character range, and the range
 * resolves to a page the viewer can scroll to and highlight. If offsets drift
 * by even one character, citations point at the wrong sentence — and they do it
 * silently, because nothing downstream can tell a wrong offset from a right
 * one.
 *
 * The guarantee is not maintained by careful arithmetic scattered through four
 * format handlers. Every handler produces nothing but an array of page STRINGS,
 * and `assemblePages` below is the single place that joins them and computes
 * offsets. There is exactly one implementation of the invariant, so there is
 * exactly one place it could be wrong — and it is tested directly.
 * ───────────────────────────────────────────────────────────────────────────
 */

/**
 * What joins one page's text to the next in the concatenated document text.
 *
 * A blank line, so the structure-aware chunker sees a page break as at least a
 * paragraph boundary and never merges the last sentence of one page with the
 * first of the next.
 */
export const PAGE_SEPARATOR = "\n\n";

/**
 * Below this average, a PDF is treated as having no text layer.
 *
 * Averaged across the whole document rather than per page, because a real
 * document legitimately contains near-empty pages — section dividers, a page
 * that is one figure — and rejecting a 300-page contract over its blank page 7
 * would be worse than useless.
 */
export const MIN_CHARS_PER_PAGE = 100;

/**
 * Target size of a synthesized page for formats that have no pages.
 *
 * Roughly a printed page of prose. It exists so that a citation into a 200-page
 * Word document points at "block 43 of 210" rather than "somewhere in this
 * document", and so the Evidence Rail has more than one tick position to work
 * with.
 */
export const SYNTHETIC_PAGE_TARGET_CHARS = 3000;

/** One page of extracted text, with its span in the concatenated document text. */
export interface ExtractedPage {
  /** 1-based. Physical page for PDFs, sequential block index otherwise. */
  pageNumber: number;
  text: string;
  /** Inclusive offset into `ExtractionResult.text`. */
  charStart: number;
  /** Exclusive offset into `ExtractionResult.text`. */
  charEnd: number;
}

/**
 * Whether page numbers mean anything to the person reading them.
 *
 * `physical` — real pages from the file itself. A citation may say "page 14".
 * `synthetic` — the format has no pages (DOCX, TXT, MD) and these boundaries
 *   were invented by the paginator. The UI must say "block 3", not "page 3": a
 *   citation must never claim a precision the source does not have.
 */
export type PageBoundaryKind = "physical" | "synthetic";

export interface ExtractionResult {
  /** The document's concatenated text. All offsets in the pipeline index this. */
  text: string;
  pages: ExtractedPage[];
  pageCount: number;
  pageBoundaries: PageBoundaryKind;
  /** True when text came from an OCR provider rather than a real text layer. */
  ocrUsed: boolean;
}

/**
 * Why extraction refused. The code is for branching and logs; `message` is
 * written for the person who uploaded the file and is what lands in
 * `documents.error_message`.
 *
 * There is deliberately no generic "extraction failed" case. Every path that
 * can fail names what it found, because "we couldn't read your file" gives the
 * user nothing to do next.
 */
export type ExtractionErrorCode =
  | "unsupported_type"
  | "type_mismatch"
  | "encrypted"
  | "corrupt"
  | "no_pages"
  | "empty_document"
  | "no_text_layer";

export class ExtractionError extends Error {
  readonly code: ExtractionErrorCode;

  constructor(code: ExtractionErrorCode, message: string) {
    super(message);
    this.name = "ExtractionError";
    this.code = code;
  }
}

/**
 * ┌──────────────────────────── OCR SEAM ────────────────────────────────────┐
 * │ Scanned PDFs are the single most common upload failure in a document Q&A │
 * │ product, and this is where support for them plugs in. Nothing here calls │
 * │ an OCR service today: without a provider, a PDF with no text layer is    │
 * │ REFUSED with a message that says so, rather than being indexed as an     │
 * │ empty document that answers every question with "not found".             │
 * │                                                                          │
 * │ To add OCR, implement this interface — Tesseract via WASM, or a hosted   │
 * │ vision model reading page images from `renderPageAsImage` in unpdf — and │
 * │ pass it to `extractDocument`. Nothing else in the pipeline changes: the  │
 * │ recognized text rejoins the same normalization, the same pagination, and │
 * │ the same offset guarantee as a real text layer.                          │
 * │                                                                          │
 * │ One thing to decide when that happens: OCR text is a GUESS, and a        │
 * │ citation into it deserves a visible confidence marker. The `ocrUsed`     │
 * │ flag on the result exists so that decision is not lost.                  │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
export interface OcrProvider {
  readonly name: string;
  /** Recognize the given 1-based pages. Missing entries are treated as empty. */
  recognizePages(input: {
    data: Uint8Array;
    pageNumbers: number[];
  }): Promise<Map<number, string>>;
}

export interface ExtractionInput {
  data: Uint8Array;
  /** Used for the extension, which decides which handler runs. */
  filename: string;
  /** The verified stored content type from `documents.mime_type`. */
  mimeType: string;
  ocr?: OcrProvider;
}

/* ========================================================================== *
 * THE INVARIANT
 * ========================================================================== */

/**
 * Join page texts into the document text and record each page's span.
 *
 * THE ONLY PLACE offsets are computed. Every format handler funnels through
 * here, so the offset guarantee has one implementation and one test.
 *
 * Note what this does NOT do: it does not measure the source file, count bytes,
 * or trust anything a parser reported. Offsets are derived from the strings
 * being concatenated, in the same pass that concatenates them, which is why
 * they cannot disagree with the text.
 */
export function assemblePages(pageTexts: string[]): {
  text: string;
  pages: ExtractedPage[];
} {
  const pages: ExtractedPage[] = [];
  const parts: string[] = [];
  let cursor = 0;

  pageTexts.forEach((pageText, index) => {
    if (index > 0) {
      parts.push(PAGE_SEPARATOR);
      cursor += PAGE_SEPARATOR.length;
    }
    pages.push({
      pageNumber: index + 1,
      text: pageText,
      charStart: cursor,
      charEnd: cursor + pageText.length,
    });
    parts.push(pageText);
    cursor += pageText.length;
  });

  return { text: parts.join(""), pages };
}

/* ========================================================================== *
 * NORMALIZATION
 * ========================================================================== */

/** Invisible characters that carry no meaning and break exact matching. */
const INVISIBLES = /[\u00AD\u200B\u200C\u200D\u2060\uFEFF]/g;

/**
 * Clean up text extracted from a PDF.
 *
 * CONSERVATIVE ON PURPOSE. The offsets recorded here are what the viewer will
 * later use to find and highlight a passage in the rendered page, so every
 * transformation applied here is a transformation the highlighter has to undo
 * or tolerate. Reflowing paragraphs — joining every line of a paragraph into
 * one long line, the usual "clean up PDF text" move — would make the stored
 * text unrecognisable against what PDF.js reports at render time and break
 * highlighting for every citation in the document.
 *
 * So the rules are limited to noise that extraction itself introduced:
 *
 *   - line endings normalized to \n;
 *   - soft hyphens and zero-width characters dropped;
 *   - words broken across a line by hyphenation rejoined;
 *   - runs of spaces and tabs collapsed to one space, never across a newline;
 *   - trailing spaces on a line removed;
 *   - three or more consecutive newlines capped at two.
 *
 * Line structure survives all of it. Nothing is reordered, and no line break
 * inside a paragraph is removed.
 */
export function normalizePdfText(raw: string): string {
  return (
    raw
      .replace(/\r\n?/g, "\n")
      .replace(INVISIBLES, "")
      // Rejoin a word split across a line break: "termi-\nnation" -> "termination".
      //
      // HEURISTIC, and it can be wrong: a genuine compound broken at its own
      // hyphen ("well-\nknown") is closed up to "wellknown". Distinguishing the
      // two needs a dictionary. Requiring lowercase on both sides keeps it away
      // from the cases where being wrong is most visible — proper nouns, and
      // hyphenated terms at the start of a sentence.
      .replace(/([a-z]{2,})-\n([a-z])/g, "$1$2")
      // Runs of horizontal whitespace only. \n is excluded from the class, so
      // line structure is untouched.
      .replace(/[^\S\n]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * Clean up text that arrived as text — TXT, Markdown, and the Markdown-ish
 * output of the DOCX handler.
 *
 * Much lighter than the PDF pass, because there is no extraction noise to
 * remove: the bytes ARE the text. Runs of spaces INSIDE a line are left alone,
 * which is what preserves the indentation of fenced and indented code blocks
 * and of nested lists. Trailing whitespace at the end of a line is removed —
 * it is invisible, it only adds noise to the lexical index, and the one thing
 * it means in Markdown (a two-space hard line break) is not worth carrying
 * through retrieval.
 *
 * Runs of three or more newlines are capped at two. That is not cosmetic — the
 * paginator splits on the blank line between paragraphs and rejoins with
 * exactly one blank line, so capping here is what makes a text document's
 * concatenated text identical to its normalized source.
 */
export function normalizeSourceText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(INVISIBLES, "")
    // NUL and other C0 controls survive copy-paste from odd sources and break
    // Postgres text columns. Tab and newline are kept.
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "")
    .replace(/[^\S\n]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ========================================================================== *
 * PAGINATION FOR FORMATS THAT HAVE NO PAGES
 * ========================================================================== */

/**
 * Split text into synthetic pages at paragraph boundaries.
 *
 * Splits happen on the blank line between paragraphs and the pages are rejoined
 * with exactly that, so for any normalized text the concatenation reproduces
 * the source exactly. A paragraph is never cut in half — which matters because
 * the chunker downstream splits on structure, and a paragraph torn across a
 * page boundary would look like two short paragraphs to it.
 *
 * The one exception is a single paragraph longer than the target, which has no
 * internal blank line to split on. It is broken at a line break or a space
 * instead, and rejoining then inserts a blank line that was not in the source.
 * The offset guarantee still holds — offsets index the concatenation, which is
 * the definition of the document text — but the text of such a document differs
 * from its source by that one blank line.
 */
export function paginateText(
  text: string,
  targetChars: number = SYNTHETIC_PAGE_TARGET_CHARS,
): string[] {
  if (text.length === 0) return [];
  if (text.length <= targetChars) return [text];

  const paragraphs = text.split(PAGE_SEPARATOR);
  const pages: string[] = [];
  let current: string[] = [];
  let currentLength = 0;

  const flush = () => {
    if (current.length > 0) {
      pages.push(current.join(PAGE_SEPARATOR));
      current = [];
      currentLength = 0;
    }
  };

  for (const paragraph of paragraphs) {
    const cost =
      current.length === 0
        ? paragraph.length
        : paragraph.length + PAGE_SEPARATOR.length;

    if (currentLength > 0 && currentLength + cost > targetChars) flush();

    if (paragraph.length > targetChars) {
      flush();
      pages.push(...splitOversizedParagraph(paragraph, targetChars));
      continue;
    }

    current.push(paragraph);
    currentLength += current.length === 1 ? paragraph.length : cost;
  }

  flush();
  return pages;
}

/** Break a paragraph with no blank line in it, preferring a line or word boundary. */
function splitOversizedParagraph(
  paragraph: string,
  targetChars: number,
): string[] {
  const pieces: string[] = [];
  let rest = paragraph;

  while (rest.length > targetChars) {
    const window = rest.slice(0, targetChars);
    // Look for a break in the last fifth of the window, so a split never
    // lands mid-word when there is any alternative.
    const floor = Math.floor(targetChars * 0.8);
    const newline = window.lastIndexOf("\n");
    const space = window.lastIndexOf(" ");
    const cut =
      newline >= floor ? newline : space >= floor ? space : targetChars;

    pieces.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }

  if (rest.length > 0) pieces.push(rest);
  return pieces;
}

/* ========================================================================== *
 * FORMAT SNIFFING — the extension is a claim, not a fact
 * ========================================================================== */

export type SniffedFormat = "pdf" | "zip" | "text" | "binary";

/** How many bytes to look at. The PDF header may sit behind leading junk. */
const SNIFF_WINDOW = 1024;

/**
 * Identify a file by its leading bytes.
 *
 * The upload path already verified the STORED content type against what the
 * client declared, but both of those ultimately derive from the filename the
 * browser reported. Renaming `invoice.docx` to `invoice.pdf` defeats every
 * check up to this point; only the bytes settle it. Getting this wrong means
 * handing a ZIP to a PDF parser and reporting "damaged file" for a file that is
 * not damaged at all.
 */
export function sniffFormat(data: Uint8Array): SniffedFormat {
  const window = data.subarray(0, SNIFF_WINDOW);

  // "%PDF-" anywhere in the first kilobyte. The specification allows leading
  // bytes before the header and real-world files do use them.
  const header = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
  for (let i = 0; i + header.length <= window.length; i += 1) {
    let matched = true;
    for (let j = 0; j < header.length; j += 1) {
      if (window[i + j] !== header[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return "pdf";
  }

  // ZIP local header, empty archive, or spanned archive. DOCX is a ZIP.
  if (
    window[0] === 0x50 &&
    window[1] === 0x4b &&
    (window[2] === 0x03 || window[2] === 0x05 || window[2] === 0x07)
  ) {
    return "zip";
  }

  // A NUL byte in the first kilobyte means this is not text.
  if (window.includes(0)) return "binary";

  return "text";
}

/** Human names for what was actually found, for the mismatch message. */
const FORMAT_NAMES: Record<SniffedFormat, string> = {
  pdf: "a PDF",
  zip: "a ZIP archive (a DOCX is one)",
  text: "plain text",
  binary: "binary data",
};

/* ========================================================================== *
 * PDF
 * ========================================================================== */

/**
 * Map a PDF.js failure onto a specific message.
 *
 * PDF.js reports its own failures as exceptions with stable `name` values, and
 * the three that matter to a person uploading a file are password-protection,
 * a damaged file, and truncation. Exported so the mapping can be tested without
 * having to manufacture an encrypted PDF.
 */
export function describePdfFailure(error: unknown): ExtractionError {
  const name =
    error instanceof Error ? error.name : String((error as { name?: string })?.name ?? "");

  if (name === "PasswordException") {
    return new ExtractionError(
      "encrypted",
      "This PDF is password-protected, so its text can't be read. Remove the password and upload it again.",
    );
  }
  if (name === "MissingPDFException") {
    return new ExtractionError(
      "corrupt",
      "This PDF is incomplete — the file appears to have been truncated during upload. Upload it again.",
    );
  }
  if (name === "InvalidPDFException") {
    return new ExtractionError(
      "corrupt",
      "This PDF's internal structure is damaged and can't be parsed. Try opening it and re-saving or re-exporting it as a PDF.",
    );
  }
  return new ExtractionError(
    "corrupt",
    "This PDF could not be parsed. It may be damaged — try opening it and re-exporting it as a PDF.",
  );
}

async function extractPdf(
  data: Uint8Array,
  ocr: OcrProvider | undefined,
): Promise<ExtractionResult> {
  let proxy;
  try {
    proxy = await getDocumentProxy(data);
  } catch (error) {
    throw describePdfFailure(error);
  }

  const pageCount = proxy.numPages;
  if (pageCount === 0) {
    throw new ExtractionError(
      "no_pages",
      "This PDF contains no pages. It may have been exported incorrectly — try re-exporting it.",
    );
  }

  let rawPages: string[];
  try {
    const extracted = await extractText(proxy, { mergePages: false });
    rawPages = extracted.text;
  } catch (error) {
    throw describePdfFailure(error);
  }

  let pageTexts = rawPages.map(normalizePdfText);
  let ocrUsed = false;

  if (!hasUsableTextLayer(pageTexts)) {
    if (!ocr) {
      throw new ExtractionError(
        "no_text_layer",
        "This PDF has no selectable text — it looks like a scan. OCR isn't supported yet.",
      );
    }

    // OCR SEAM. Only the pages that came back empty are sent for recognition;
    // a mixed document with a few scanned inserts keeps its real text.
    const blank = pageTexts
      .map((text, index) => ({ text, pageNumber: index + 1 }))
      .filter((page) => page.text.length < MIN_CHARS_PER_PAGE)
      .map((page) => page.pageNumber);

    const recognized = await ocr.recognizePages({ data, pageNumbers: blank });
    pageTexts = pageTexts.map((text, index) => {
      const replacement = recognized.get(index + 1);
      return replacement ? normalizePdfText(replacement) : text;
    });
    ocrUsed = true;

    if (!hasUsableTextLayer(pageTexts)) {
      throw new ExtractionError(
        "no_text_layer",
        `This PDF has no selectable text and ${ocr.name} could not read it either. It may be a low-quality scan.`,
      );
    }
  }

  const { text, pages } = assemblePages(pageTexts);
  return {
    text,
    pages,
    pageCount: pages.length,
    pageBoundaries: "physical",
    ocrUsed,
  };
}

/** Averaged across the document — see MIN_CHARS_PER_PAGE. */
function hasUsableTextLayer(pageTexts: string[]): boolean {
  if (pageTexts.length === 0) return false;
  const total = pageTexts.reduce((sum, text) => sum + text.length, 0);
  return total / pageTexts.length >= MIN_CHARS_PER_PAGE;
}

/* ========================================================================== *
 * DOCX
 * ========================================================================== */

/**
 * Convert the narrow HTML mammoth produces into Markdown-flavoured text.
 *
 * Why not `extractRawText`: it returns paragraphs with no structure at all, and
 * the chunker downstream splits on headings first. A DOCX that arrives as one
 * undifferentiated wall of text chunks worse than the same document as a PDF,
 * and its citations lose the section breadcrumb entirely.
 *
 * Why not mammoth's own `convertToMarkdown`: it is undeclared in the package's
 * types and marked deprecated upstream. `convertToHtml` is the supported API,
 * and mammoth's output is a deliberately small tag vocabulary — headings,
 * paragraphs, lists, tables, and inline emphasis — which is a narrow enough
 * input to convert here, in code this project controls and can test.
 */
export function docxHtmlToText(html: string): string {
  return (
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div)>/gi, "\n\n")
      // Headings become ATX markers so the chunker can build a section path.
      .replace(
        /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
        (_match, level: string, inner: string) =>
          `\n\n${"#".repeat(Number(level))} ${inner.replace(/<[^>]+>/g, "").trim()}\n\n`,
      )
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<\/li>/gi, "")
      .replace(/<\/(?:ul|ol|table)>/gi, "\n\n")
      .replace(/<\/tr>/gi, "\n")
      .replace(/<\/t[dh]>/gi, "\t")
      // Everything else is inline emphasis or an anchor: keep the text, drop
      // the tag.
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#3[49];/g, "'")
  );
}

async function extractDocx(data: Uint8Array): Promise<ExtractionResult> {
  let html: string;
  try {
    const result = await mammoth.convertToHtml({
      buffer: Buffer.from(data),
    });
    html = result.value;
  } catch (error) {
    // mammoth throws on a ZIP that is not an Office package, or one whose
    // document part is missing.
    console.error("[extract] docx parse failed", error);
    throw new ExtractionError(
      "corrupt",
      "This DOCX could not be read. It may be damaged, or it may be an older .doc file renamed to .docx — open it in Word and save it as .docx.",
    );
  }

  const text = normalizeSourceText(docxHtmlToText(html));
  if (text.length === 0) {
    throw new ExtractionError(
      "empty_document",
      "This DOCX contains no text. If its content is images, they can't be read yet.",
    );
  }

  const { text: assembled, pages } = assemblePages(paginateText(text));
  return {
    text: assembled,
    pages,
    pageCount: pages.length,
    // A DOCX has no pages. Word's own page numbers depend on the printer
    // driver, the fonts installed, and the zoom level, so there is no stable
    // page number to record even if we rendered it.
    pageBoundaries: "synthetic",
    ocrUsed: false,
  };
}

/* ========================================================================== *
 * TXT / MARKDOWN
 * ========================================================================== */

function extractPlainText(data: Uint8Array): ExtractionResult {
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(data);
  const text = normalizeSourceText(decoded);

  if (text.length === 0) {
    throw new ExtractionError(
      "empty_document",
      "This file is empty. There is nothing to read.",
    );
  }

  // Markdown heading structure is left exactly as written: `## 7. Termination`
  // stays in the text, because the chunker builds its section breadcrumb from
  // those markers and the viewer renders them.
  const { text: assembled, pages } = assemblePages(paginateText(text));
  return {
    text: assembled,
    pages,
    pageCount: pages.length,
    pageBoundaries: "synthetic",
    ocrUsed: false,
  };
}

/* ========================================================================== *
 * ENTRY POINT
 * ========================================================================== */

type Handler = "pdf" | "docx" | "text";

/** Which handler an extension asks for, and what its bytes must look like. */
const HANDLERS: Record<string, { handler: Handler; expects: SniffedFormat }> = {
  ".pdf": { handler: "pdf", expects: "pdf" },
  ".docx": { handler: "docx", expects: "zip" },
  ".txt": { handler: "text", expects: "text" },
  ".md": { handler: "text", expects: "text" },
};

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

/**
 * Extract one document.
 *
 * Ordering is deliberate: the extension chooses a handler, the bytes are
 * checked against what that handler expects, and only then is a parser handed
 * the file. Every refusal names what was actually found.
 */
export async function extractDocument(
  input: ExtractionInput,
): Promise<ExtractionResult> {
  const extension = extensionOf(input.filename);
  const entry = HANDLERS[extension];

  if (!entry) {
    throw new ExtractionError(
      "unsupported_type",
      `${extension || "This file"} can't be read. Upload a PDF, DOCX, TXT, or Markdown file.`,
    );
  }

  if (input.data.length === 0) {
    throw new ExtractionError(
      "empty_document",
      "This file is empty. There is nothing to read.",
    );
  }

  const sniffed = sniffFormat(input.data);
  if (sniffed !== entry.expects) {
    // A text handler is the one lenient case: a .md file that sniffs as
    // "binary" because it happens to contain a NUL is still worth refusing,
    // but a .txt sniffing as anything textual is fine.
    throw new ExtractionError(
      "type_mismatch",
      `This file is named ${extension} but its contents are ${FORMAT_NAMES[sniffed]}. Rename it to the right extension, or upload the original file.`,
    );
  }

  switch (entry.handler) {
    case "pdf":
      return extractPdf(input.data, input.ocr);
    case "docx":
      return extractDocx(input.data);
    case "text":
      return extractPlainText(input.data);
  }
}
