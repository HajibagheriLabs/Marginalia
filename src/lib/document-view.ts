import { asc, eq } from "drizzle-orm";

import { db } from "@/db";
import { documentPages } from "@/db/schema";
import type { Document } from "@/db/schema";
import { estimateTextPageHeight, splitBlocks } from "@/lib/viewer/blocks";
import type {
  DocumentView,
  PageBoundaries,
  ViewerKind,
  ViewerPage,
} from "@/lib/viewer/types";

/**
 * Assembling what the viewer renders.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * PDFs DO NOT SHIP THEIR TEXT; TEXT DOCUMENTS ARE THEIR TEXT
 *
 * For a PDF the browser already downloads the original file and PDF.js renders
 * from it, so sending `document_pages.text` as well would be sending the
 * document twice — a second megabyte or two on a 300-page contract, to
 * populate nothing that is drawn. Search reaches that text on the server
 * instead, which is also the only way search can cover pages the virtualiser
 * has not rendered.
 *
 * For a DOCX, TXT, or Markdown file the extracted text IS the content: there
 * is nothing else to render, and the original file is only useful as a
 * download. So it ships, and it ships verbatim — the DOM text has to equal the
 * stored text for character-level citation targeting to be arithmetic rather
 * than guesswork. See `anchors.ts`.
 */

/**
 * Where the browser fetches a document's original bytes.
 *
 * Root-relative, so it resolves identically under `next dev`, `next start`, and
 * a deployment, and so the request carries the session cookie.
 */
export function documentFileUrl(documentId: string): string {
  return `/api/documents/${documentId}/file`;
}

/** The one place a mime type becomes a rendering decision. */
export function viewerKindFor(mimeType: string): ViewerKind {
  return mimeType === "application/pdf" ? "pdf" : "text";
}

/**
 * Whether this document's page numbers are real.
 *
 * Derived from the mime type rather than stored, because it is not an
 * independent fact: extraction decides it the same way, from the same input.
 * A column would be a second copy of a derivation that can then disagree with
 * the first — and the failure would be a citation claiming "page 14" of a Word
 * document, which has no page 14.
 */
export function boundariesFor(mimeType: string): PageBoundaries {
  return viewerKindFor(mimeType) === "pdf" ? "physical" : "synthetic";
}

/**
 * Build the view for one document.
 *
 * Takes the already-authorised row rather than an id: the caller reached it
 * through `requireDocumentAccess`, and re-loading it here would either repeat
 * that check or, worse, skip it.
 */
export async function loadDocumentView(
  document: Document,
): Promise<DocumentView> {
  const kind = viewerKindFor(document.mimeType);

  const rows = await db
    .select({
      pageNumber: documentPages.pageNumber,
      text: documentPages.text,
      charStart: documentPages.charStart,
      charEnd: documentPages.charEnd,
    })
    .from(documentPages)
    .where(eq(documentPages.documentId, document.id))
    .orderBy(asc(documentPages.pageNumber));

  const pages: ViewerPage[] = rows.map((row) => {
    if (kind === "pdf") {
      return {
        pageNumber: row.pageNumber,
        charStart: row.charStart,
        charEnd: row.charEnd,
        // Replaced by the page's real viewport as soon as PDF.js reports it.
        // A4 at 96dpi is the honest default: it is what most of these files
        // are, and it is only ever the height of a placeholder.
        estimatedHeight: 1123,
      };
    }

    return {
      pageNumber: row.pageNumber,
      charStart: row.charStart,
      charEnd: row.charEnd,
      text: row.text,
      estimatedHeight: estimateTextPageHeight(
        row.text.length,
        splitBlocks(row.text).length,
      ),
    };
  });

  return {
    documentId: document.id,
    title: document.title,
    filename: document.filename,
    mimeType: document.mimeType,
    byteSize: document.byteSize,
    kind,
    boundaries: boundariesFor(document.mimeType),
    /*
     * NEVER `document.blob_url`.
     *
     * The blob store is private, so that URL is not fetchable by a browser at
     * all — and even if it were, it is a bearer capability with no session
     * behind it and no way to revoke it. Both the viewer and the download link
     * go through a route on this origin that re-checks ownership on every
     * request and serves the bytes as an attachment. See
     * src/app/api/documents/[documentId]/file/route.ts.
     */
    fileUrl: kind === "pdf" ? documentFileUrl(document.id) : null,
    downloadUrl: documentFileUrl(document.id),
    // `page_count` is the extractor's number and the pages are the rows it
    // wrote; they agree, but the rows are what is actually rendered, so they
    // are what the count is taken from.
    pageCount: pages.length,
    pages,
  };
}

/**
 * The page text search runs over. Never sent to the client for a PDF.
 *
 * Deliberately a separate read from `loadDocumentView`: the view is fetched on
 * every navigation to a document, and search happens when someone presses
 * Cmd+F. Loading a 300-page contract's full text on the first render to serve
 * a search that may never happen is the cost this split avoids.
 */
export async function loadPageText(
  documentId: string,
): Promise<{ pageNumber: number; text: string }[]> {
  return db
    .select({
      pageNumber: documentPages.pageNumber,
      text: documentPages.text,
    })
    .from(documentPages)
    .where(eq(documentPages.documentId, documentId))
    .orderBy(asc(documentPages.pageNumber));
}
