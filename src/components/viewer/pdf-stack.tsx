"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { Document } from "react-pdf";
import type { PDFDocumentProxy } from "pdfjs-dist";

import { PageDivider } from "@/components/viewer/page-divider";
import { PdfPage } from "@/components/viewer/pdf-pages";
import { configurePdfWorker, PDF_OPTIONS } from "@/lib/viewer/pdf-worker";
import type { ViewerPage } from "@/lib/viewer/types";

/**
 * THE PDF SIDE OF THE VIEWER.
 *
 * Imported dynamically with `ssr: false` by the viewer shell, for two reasons
 * that both matter:
 *
 *   - PDF.js touches DOM globals at module scope. Rendering it on the server
 *     is not slow, it is a crash.
 *   - It is about a megabyte of JavaScript. A reader opening a Word document
 *     should not download a PDF engine to look at it, and this is the seam
 *     that makes sure they do not.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * HEIGHTS ARE MEASURED BEFORE ANYTHING IS DRAWN
 *
 * `getPage(n).getViewport()` returns a page's dimensions without rasterising
 * it — it reads the page dictionary, not the content stream. So every page's
 * exact height is known before the first pixel, which is what lets the
 * virtualiser size all 300 placeholders correctly on the first paint and never
 * correct them. That is the difference between a scrollbar that is stable and
 * one that grows under the reader as they scroll.
 *
 * Page one is measured first and applied to every page as a provisional size,
 * so the stack has a sensible height immediately; the rest are measured in
 * batches straight afterwards. Nearly every document is uniform, so nearly
 * every document is exactly right from the first frame.
 */

/** Pages measured per batch, yielding to the event loop between them. */
const MEASURE_BATCH = 25;

export interface PdfPageSize {
  width: number;
  height: number;
}

export function PdfStack({
  fileUrl,
  pages,
  range,
  offsetOf,
  totalHeight,
  scale,
  stackRef,
  matchIndicesByPage,
  matcher,
  currentMatchIndex,
  pageLabel,
  onMeasure,
  onSizes,
  onError,
  loading,
}: {
  fileUrl: string;
  pages: ViewerPage[];
  range: { start: number; end: number };
  offsetOf: (index: number) => number;
  totalHeight: number;
  scale: number;
  stackRef: RefObject<HTMLDivElement | null>;
  /** Document-wide match indices, keyed by page number. */
  matchIndicesByPage: Map<number, number[]>;
  matcher: RegExp | null;
  currentMatchIndex: number | null;
  /** "Page" or "Block" — the viewer decides once, from the boundary kind. */
  pageLabel: string;
  onMeasure: (index: number, height: number) => void;
  onSizes: (sizes: PdfPageSize[]) => void;
  onError: (error: Error) => void;
  loading: React.ReactNode;
}) {
  // Assigning `GlobalWorkerOptions.workerSrc` before the first <Document>
  // mounts. It is a module-level singleton, so this is idempotent.
  configurePdfWorker();

  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const handleLoad = useCallback(
    async (pdf: PDFDocumentProxy) => {
      try {
        const first = await pdf.getPage(1);
        const firstViewport = first.getViewport({ scale: 1 });
        const provisional: PdfPageSize[] = Array.from(
          { length: pdf.numPages },
          () => ({ width: firstViewport.width, height: firstViewport.height }),
        );
        if (cancelledRef.current) return;
        onSizes(provisional);

        // The remainder, in batches. Awaiting each batch yields to the event
        // loop, so measuring a 300-page document cannot block the first paint
        // of the pages the reader is already looking at.
        const sizes = provisional.slice();
        for (
          let start = 1;
          start < pdf.numPages;
          start += MEASURE_BATCH
        ) {
          const end = Math.min(pdf.numPages, start + MEASURE_BATCH);
          const batch = await Promise.all(
            Array.from({ length: end - start }, (_, offset) =>
              pdf.getPage(start + offset + 1),
            ),
          );
          if (cancelledRef.current) return;

          batch.forEach((page, offset) => {
            const viewport = page.getViewport({ scale: 1 });
            sizes[start + offset] = {
              width: viewport.width,
              height: viewport.height,
            };
          });
          onSizes(sizes.slice());
        }
      } catch (error) {
        if (!cancelledRef.current) {
          onError(
            error instanceof Error
              ? error
              : new Error("This PDF could not be read."),
          );
        }
      }
    },
    [onError, onSizes],
  );

  const visible = pages.slice(range.start, range.end);

  return (
    <Document
      file={fileUrl}
      options={PDF_OPTIONS}
      onLoadSuccess={handleLoad}
      onLoadError={onError}
      loading={loading}
      // The shell renders the error state on the room, where it can offer the
      // download. A message inside the sheet would be an error printed on the
      // paper it failed to show.
      error={null}
      noData={null}
    >
      <div ref={stackRef} className="relative" style={{ height: totalHeight }}>
        {visible.map((page, offset) => {
          const index = range.start + offset;
          return (
            <div
              key={page.pageNumber}
              className="absolute inset-x-0"
              style={{ top: offsetOf(index) }}
            >
              {index > 0 ? (
                <PageDivider label={`${pageLabel} ${page.pageNumber}`} />
              ) : null}
              <PdfPage
                page={page}
                index={index}
                scale={scale}
                matchIndices={matchIndicesByPage.get(page.pageNumber) ?? []}
                matcher={matcher}
                currentMatchIndex={currentMatchIndex}
                onMeasure={onMeasure}
              />
            </div>
          );
        })}
      </div>
    </Document>
  );
}
