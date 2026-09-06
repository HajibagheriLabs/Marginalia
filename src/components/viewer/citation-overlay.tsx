"use client";

import { useEffect, useState, type CSSProperties, type RefObject } from "react";

import {
  bandRects,
  collectText,
  rangeFor,
  type Band,
} from "@/components/viewer/dom-range";
import type { CitationMark } from "@/components/viewer/citation-bridge";
import { PAGE_NUMBER_ATTR, PAGE_SELECTOR } from "@/lib/viewer/anchors";
import { locatePassage } from "@/lib/viewer/passage";
import { inkVar, type InkName } from "@/lib/ink";
import { cn } from "@/lib/utils";

/**
 * THE HIGHLIGHT ON THE PAGE.
 *
 * A citation chip and the band it lights are the two halves of the same
 * gesture, and this is the half that lands on paper. It is drawn as an overlay
 * of absolutely positioned bands rather than by wrapping the words in a
 * `<mark>`, for one decisive reason: a PDF page's words belong to PDF.js's
 * text layer, whose innerHTML is already owned by the search highlighter.
 * Two mechanisms writing the same nodes is a bug waiting for the first reader
 * who searches and clicks a citation in the same minute.
 *
 * An overlay also gets the geometry right for free. `Range.getClientRects()`
 * accounts for the per-span `scaleX` PDF.js applies, for zoom, and for line
 * wrapping, so a passage spanning four lines and two font changes comes back
 * as the four bands a highlighter pen would have left.
 */

/** How the passage was found. `page` is the fallback, and it is visible. */
export type PaintKind = "exact" | "partial" | "page";

export interface PaintedCitation {
  markId: string;
  ink: InkName;
  /** The citation that was clicked, versus the rest of its answer. */
  role: "active" | "context";
  kind: PaintKind;
  bands: Band[];
}

/** The full wipe, across however many lines the passage covers. */
const WIPE_MS = 220;

/**
 * Resolve citations to bands.
 *
 * Runs in a `requestAnimationFrame` rather than straight from the effect, and
 * both reasons are real: a PDF page's text layer is inserted after its canvas
 * rasterises, so a synchronous read can find an empty page that is about to be
 * full; and deferring keeps a DOM measurement out of the render pass that
 * caused it.
 *
 * `renderVersion` is what makes the retry unnecessary — the viewer bumps it
 * whenever a text layer arrives or a page is measured, so resolution re-runs
 * exactly when there is new DOM to look at, instead of on a timer.
 */
export function useCitationBands({
  overlayRef,
  rootRef,
  requests,
  renderVersion,
}: {
  overlayRef: RefObject<HTMLDivElement | null>;
  /** The scroll container, so page lookup cannot escape this viewer. */
  rootRef: RefObject<HTMLElement | null>;
  requests: { mark: CitationMark; ink: InkName; role: "active" | "context" }[];
  /**
   * Everything that can move a band without changing `requests`: which pages
   * are mounted, whether their text layers have arrived, and the zoom. Folded
   * into one key because they are one question — "is the DOM different from
   * the last time we measured it?" — and the browser will not answer it.
   */
  renderVersion: string;
}): PaintedCitation[] {
  const [painted, setPainted] = useState<PaintedCitation[]>([]);

  useEffect(() => {
    let cancelled = false;

    const frame = requestAnimationFrame(() => {
      if (cancelled) return;

      const overlay = overlayRef.current;
      const root = rootRef.current;
      if (!overlay || !root) {
        setPainted((previous) => (previous.length === 0 ? previous : []));
        return;
      }

      const origin = overlay.getBoundingClientRect();

      // The pane is hidden — below 1024px it is a tab, and the other one is on
      // screen. A hidden element measures zero, so resolving now would find no
      // rectangles and report every citation as "exact passage not found".
      // Keeping the last resolution and waiting for the resize is correct:
      // the pane is about to become visible, which is what bumps the version.
      if (origin.width === 0 && origin.height === 0) return;

      const resolved: PaintedCitation[] = [];

      for (const request of requests) {
        const pages = pageElements(root, request.mark);
        // Not mounted yet: the virtualiser has been told to scroll there and
        // this will re-run when it does. Painting nothing is correct for now.
        if (pages.length === 0) continue;

        const source = collectText(pages);
        const quote = request.mark.quotedText ?? "";
        const match = quote ? locatePassage(source.text, quote) : null;

        if (match) {
          const range = rangeFor(source, match.start, match.end);
          const bands = range ? bandRects(range, origin) : [];
          if (bands.length > 0) {
            resolved.push({
              markId: request.mark.id,
              ink: request.ink,
              role: request.role,
              kind: match.kind,
              bands,
            });
            continue;
          }
        }

        /* ── THE PAGE-LEVEL FALLBACK ───────────────────────────────────────
         * The quote could not be found on the page it claims to be on. That
         * happens for a scanned page whose text layer disagrees with the
         * extractor, or for a citation whose chunk has since been re-ingested.
         *
         * The passage is NOT guessed at. A band over approximately-the-right
         * paragraph would be the interface asserting a provenance it does not
         * have, and it would be indistinguishable from a correct highlight.
         * Instead the whole page is marked, and the viewer says so in words —
         * see the note under the toolbar.
         *
         * ONLY FOR THE CITATION THAT WAS CLICKED. A context citation falling
         * back would wash a whole page at 12% with nothing to explain it,
         * because the note names one page and one failure. An unresolvable
         * sibling is simply not drawn: the reader asked about the other one.
         */
        if (request.role === "context") continue;

        resolved.push({
          markId: request.mark.id,
          ink: request.ink,
          role: request.role,
          kind: "page",
          bands: pages.map((page) => {
            const rect = page.getBoundingClientRect();
            return {
              left: rect.left - origin.left,
              top: rect.top - origin.top,
              width: rect.width,
              height: rect.height,
            };
          }),
        });
      }

      setPainted(resolved);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [overlayRef, rootRef, requests, renderVersion]);

  return painted;
}

/** The mounted page elements a citation spans, in order. */
function pageElements(root: HTMLElement, mark: CitationMark): Element[] {
  const found: Element[] = [];
  for (let page = mark.pageFrom; page <= mark.pageTo; page += 1) {
    const element = root.querySelector(
      `${PAGE_SELECTOR}[${PAGE_NUMBER_ATTR}="${page}"]`,
    );
    if (element) found.push(element);
  }
  return found;
}

export function CitationOverlay({
  overlayRef,
  painted,
  /** Bumped on every activation, so re-clicking the same chip replays the wipe. */
  nonce,
}: {
  overlayRef: RefObject<HTMLDivElement | null>;
  painted: PaintedCitation[];
  nonce: number;
}) {
  return (
    <div
      ref={overlayRef}
      // Decorative: the passage itself is already in the text layer, and the
      // chip that lit it is the thing a screen reader should be reading.
      aria-hidden
      // Above the canvas, below PDF.js's text layer (z-index 2), so selection
      // and search marks stay on top of the band the way ink sits on paper.
      className="pointer-events-none absolute inset-0 z-[1]"
    >
      {painted.map((citation) => (
        <div
          // The active group is keyed by the nonce so React remounts it on
          // every activation. That is what replays the CSS animation; toggling
          // a class would not, because the animation has already finished.
          key={
            citation.role === "active"
              ? `${citation.markId}:${nonce}`
              : citation.markId
          }
        >
          {citation.bands.map((band, index) => (
            <span
              key={index}
              style={
                {
                  left: band.left,
                  top: band.top,
                  width: band.width,
                  height: band.height,
                  "--ink": inkVar(citation.ink),
                  ...wipe(citation.role, index, citation.bands.length),
                } as CSSProperties
              }
              className={cn(
                "absolute rounded-[1px]",
                citation.role === "context"
                  ? "citation-band-context"
                  : citation.kind === "page"
                    ? "citation-page-mark"
                    : "citation-band animate-ink-in",
              )}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * One left-to-right sweep across the whole passage, not one per line.
 *
 * Each line's wipe starts where the previous one would have finished, so a
 * four-line passage reads as a single pen stroke rather than four
 * simultaneous flashes. The per-line duration is floored so that a passage
 * covering fifteen lines still animates rather than strobing.
 *
 * `prefers-reduced-motion` collapses all of it in globals.css — the highlight
 * appears instantly, which is the point of the setting.
 */
function wipe(
  role: "active" | "context",
  index: number,
  count: number,
): CSSProperties {
  if (role !== "active") return {};
  const step = WIPE_MS / Math.max(1, count);
  return {
    animationDelay: `${Math.round(index * step)}ms`,
    animationDuration: `${Math.round(Math.max(90, step * 1.6))}ms`,
  };
}
