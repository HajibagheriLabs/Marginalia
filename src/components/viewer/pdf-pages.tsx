"use client";

import { useMemo } from "react";
import { Page } from "react-pdf";

import { pageAnchorProps } from "@/lib/viewer/anchors";
import { findMatches } from "@/lib/viewer/search";
import type { ViewerPage } from "@/lib/viewer/types";

/**
 * ONE PDF PAGE.
 *
 * A rasterised canvas with PDF.js's text layer over it. THE TEXT LAYER IS THE
 * POINT — it is what makes the page selectable, what search paints into, and
 * what citation highlighting attaches to next. Rendering the canvas alone
 * would be faster and would produce a picture of a document rather than a
 * document.
 *
 * The annotation layer is deliberately OFF. It is where PDF.js draws form
 * fields and link targets, and it arrives with its own palette — a blue field
 * background, a focus colour — which is a vendor stylesheet putting colour on
 * the page in an application where colour means citation. Internal links are a
 * real loss; they are not worth the law.
 */
export function PdfPage({
  page,
  index,
  scale,
  /** Document-wide indices of the matches that fall on this page, in order. */
  matchIndices,
  /** The compiled query, or null when nothing is being searched. */
  matcher,
  currentMatchIndex,
  onMeasure,
  onTextLayerReady,
}: {
  page: ViewerPage;
  index: number;
  scale: number;
  matchIndices: number[];
  matcher: RegExp | null;
  currentMatchIndex: number | null;
  onMeasure: (index: number, height: number) => void;
  /**
   * The text layer is inserted after the canvas rasterises, so it is the
   * moment a citation on this page becomes findable. Announcing it is what
   * lets the highlighter re-resolve exactly when there is new text to look at,
   * rather than polling for it.
   */
  onTextLayerReady: () => void;
}) {
  /**
   * Paint search matches into the text layer.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * THE COUNT COMES FROM POSTGRES; THE PAINT HAPPENS HERE
   *
   * The authoritative search ran on the server over `document_pages.text` — it
   * has to, because it must cover the pages this viewer has not rendered, and
   * because those are the exact characters a citation's offsets index into.
   * But that text was normalised at extraction: whitespace collapsed, words
   * rejoined across hyphenated line breaks. PDF.js's text layer reports the
   * file's own strings, split into items wherever the PDF's layout says so.
   * A stored offset therefore does not index a text item, and no amount of
   * arithmetic will make it.
   *
   * So the query is re-run locally against each item, and the nth occurrence
   * found on the page is paired with the nth match the server reported for it.
   * When the two disagree — a phrase broken across a line, which the server
   * finds and an item does not contain — the reader still lands on the right
   * page with the right count, and one highlight goes unpainted. That is a
   * degradation, not a lie, and it is the price of a search that covers the
   * whole document instead of the six pages currently in the DOM.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * THIS RETURNS innerHTML
   *
   * `customTextRenderer` returns a STRING which react-pdf assigns as the
   * span's innerHTML. The page text comes out of a file a stranger uploaded,
   * so every interpolation here is escaped. This is the only place in the
   * viewer where a string becomes markup, and `escapeHtml` is the only reason
   * that is safe.
   */
  const customTextRenderer = useMemo(() => {
    if (!matcher || matchIndices.length === 0) return undefined;

    // Text items are rendered in order, and item 0 is where every pass starts,
    // so it is the reliable place to reset the running count.
    let occurrence = 0;

    return ({ str, itemIndex }: { str: string; itemIndex: number }): string => {
      if (itemIndex === 0) occurrence = 0;
      if (str.length === 0) return "";

      const found = findMatches(str, matcher);
      if (found.length === 0) return escapeHtml(str);

      const parts: string[] = [];
      let cursor = 0;

      for (const match of found) {
        const matchIndex = matchIndices[occurrence];
        occurrence += 1;

        parts.push(escapeHtml(str.slice(cursor, match.start)));

        // Past the number of matches the server reported for this page, the
        // extra occurrence is real text but has no place in the navigation
        // order. It is still marked — hiding it would look like a bug — just
        // never as the current one.
        parts.push(
          `<mark class="search-mark" data-current="${
            matchIndex !== undefined && matchIndex === currentMatchIndex
          }"${
            matchIndex === undefined ? "" : ` data-match-index="${matchIndex}"`
          }>${escapeHtml(str.slice(match.start, match.start + match.length))}</mark>`,
        );

        cursor = match.start + match.length;
      }

      parts.push(escapeHtml(str.slice(cursor)));
      return parts.join("");
    };
  }, [matcher, matchIndices, currentMatchIndex]);

  return (
    <div {...pageAnchorProps(page)} className="flex justify-center">
      <Page
        pageNumber={page.pageNumber}
        scale={scale}
        renderTextLayer
        renderAnnotationLayer={false}
        customTextRenderer={customTextRenderer}
        // Both fall back to the exact height PDF.js already reported for this
        // page, so a page that is slow or fails to rasterise cannot collapse
        // the stack and drag everything below it upward.
        loading={<div style={{ height: page.estimatedHeight }} />}
        error={
          <div
            style={{ height: page.estimatedHeight }}
            className="flex items-center justify-center px-6 text-center text-body-sm text-paper-text-muted"
          >
            This page could not be rendered.
          </div>
        }
        onRenderSuccess={(rendered) => onMeasure(index, rendered.height)}
        onRenderTextLayerSuccess={onTextLayerReady}
      />
    </div>
  );
}

/** Escape for insertion as innerHTML. The one markup boundary in the viewer. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
