/**
 * WHAT THE VIEWER IS GIVEN.
 *
 * Client-safe: no Drizzle, no Postgres driver, importable from a Client
 * Component. The server builds this in `src/lib/document-view.ts`.
 */

/**
 * How a document is rendered.
 *
 * `pdf` — PDF.js rasterises the original file and we render its text layer.
 * `text` — we render the extracted text ourselves, on the same paper sheet.
 *
 * The two share their page model completely; only the thing inside a page
 * differs. See `anchors.ts` for why that is the whole trick.
 */
export type ViewerKind = "pdf" | "text";

/**
 * Whether page numbers mean anything to the reader.
 *
 * `physical` — real pages out of the file. The UI says "Page 14".
 * `synthetic` — the format has no pages (DOCX, TXT, MD) and the paginator
 *   invented these boundaries. The UI says "Block 14", because a citation must
 *   never claim a precision the source does not have.
 */
export type PageBoundaries = "physical" | "synthetic";

/** One page, as the viewer needs it. */
export interface ViewerPage {
  /** 1-based. */
  pageNumber: number;
  /** Inclusive offset into the document's concatenated text. */
  charStart: number;
  /** Exclusive offset into the document's concatenated text. */
  charEnd: number;
  /**
   * The page's extracted text.
   *
   * Present for `text` documents, where it IS the rendered content. Absent for
   * PDFs, where PDF.js renders the original file and shipping a second copy of
   * the text would double the payload of a 300-page contract to populate
   * nothing. Search reaches that text on the server instead.
   */
  text?: string;
  /** A first guess at rendered height in px, for the virtualiser's placeholder. */
  estimatedHeight: number;
}

export interface DocumentView {
  documentId: string;
  title: string;
  filename: string;
  /** The header's readout, and what decides `kind`. */
  mimeType: string;
  byteSize: number;
  kind: ViewerKind;
  boundaries: PageBoundaries;
  /** The original file. Null for `text` documents, which render from Postgres. */
  fileUrl: string | null;
  /** Always present — every document can be downloaded as it was uploaded. */
  downloadUrl: string;
  pageCount: number;
  pages: ViewerPage[];
}

/** The word for one page in this document. Never guessed at a call site. */
export function unitLabel(
  boundaries: PageBoundaries,
  capitalized = false,
): string {
  const word = boundaries === "physical" ? "page" : "block";
  return capitalized ? word[0].toUpperCase() + word.slice(1) : word;
}
