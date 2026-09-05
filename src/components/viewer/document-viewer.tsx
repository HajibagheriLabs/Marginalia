"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import dynamic from "next/dynamic";

import { PaperSheet } from "@/components/paper-sheet";
import { PageDivider } from "@/components/viewer/page-divider";
import { PageSkeleton } from "@/components/viewer/page-skeleton";
import { TextPage } from "@/components/viewer/text-pages";
import { ViewerSearchBar } from "@/components/viewer/search-bar";
import { useVirtualPages } from "@/components/viewer/use-virtual-pages";
import {
  ViewerToolbar,
  type ZoomSetting,
} from "@/components/viewer/viewer-toolbar";
import { ErrorState } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import { EvidenceRail } from "@/components/workspace/evidence-rail";
import {
  compileQuery,
  searchPages,
  type DocumentMatch,
} from "@/lib/viewer/search";
import type { DocumentView } from "@/lib/viewer/types";
import { unitLabel } from "@/lib/viewer/types";
import { searchDocument } from "@/server/actions/viewer";

import type { PdfPageSize } from "./pdf-stack";

/**
 * THE READING PANE.
 *
 *   toolbar
 *   search bar (Cmd+F)
 *   the dark table
 *     the paper sheet
 *       a virtualised stack of pages
 *       the Evidence Rail down the right edge
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ONE VIEWER, TWO RENDERERS
 *
 * A PDF is rasterised by PDF.js with its text layer over the top; a DOCX, TXT,
 * or Markdown file is rendered as text we lay out ourselves. Everything around
 * that — the sheet, the scroll container, virtualisation, zoom, the page
 * indicator, search, the keyboard, the rail — is shared, because the two
 * renderers agree on a page model: a page is a numbered element with a
 * `char_start` and a `char_end` into the document's concatenated text. See
 * `anchors.ts` for why that is what makes citation targeting work identically
 * across formats.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THE PDF RENDERER IS LOADED DYNAMICALLY
 *
 * PDF.js touches DOM globals at module scope, so server-rendering it is a
 * crash rather than a slowdown; and it is about a megabyte of JavaScript that
 * someone reading a Word document has no use for. `ssr: false` answers both.
 */
const PdfStack = dynamic(
  () => import("./pdf-stack").then((module) => module.PdfStack),
  {
    ssr: false,
    // The chunk itself takes a moment to arrive. Showing nothing until it does
    // would put a blank sheet on the table before the skeleton appears, which
    // is a flash of empty paper immediately followed by a placeholder — two
    // states where there should be one.
    loading: () => <PageSkeleton />,
  },
);

/** Gap between pages in the stack, in px. On the 8-grid, and wide enough to
    hold the hairline and page number that sit in it. */
const PAGE_GAP = 24;

/**
 * Space kept clear down the right edge of the sheet for the Evidence Rail.
 *
 * The rail is the element this application is remembered by and it spans the
 * whole document, so it gets a lane rather than being laid over the page. A
 * text page already has 48px of margin there; a PDF page goes edge to edge and
 * would otherwise have its outer column covered by tick marks.
 */
const RAIL_LANE = 28;

/** The measure a text document is set at before zoom. Matches PaperSheet. */
const TEXT_BASE_WIDTH = 720;

/** Document text size at 100%, from the design system's `document` step. */
const TEXT_BASE_FONT_SIZE = 17;

/** How much of a viewport PageUp/PageDown moves, leaving context behind. */
const PAGE_KEY_OVERLAP = 0.9;

/** Keystrokes are cheap; a search over a 300-page document is not. */
const SEARCH_DEBOUNCE_MS = 220;

/** Stable empty result, so "no matches" does not re-render the whole stack. */
const EMPTY_MATCHES: DocumentMatch[] = [];

export function DocumentViewer({ view }: { view: DocumentView }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const [zoom, setZoom] = useState<ZoomSetting>("fit");
  const [availableWidth, setAvailableWidth] = useState(0);
  const [pdfSizes, setPdfSizes] = useState<PdfPageSize[] | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);

  const isPdf = view.kind === "pdf";

  /* ── SIZING ───────────────────────────────────────────────────────────────
   * The natural width of one page at 100%: the PDF's own page width, or the
   * sheet's reading measure for a text document. `fit` divides the space
   * available by it, and everything downstream — the sheet, the canvas scale,
   * the type size — is that one number.
   */
  const baseWidth = isPdf
    ? (pdfSizes?.[0]?.width ?? TEXT_BASE_WIDTH)
    : TEXT_BASE_WIDTH;

  const scale = useMemo(() => {
    if (zoom !== "fit") return zoom;
    if (availableWidth <= 0 || baseWidth <= 0) return 1;
    // The rail's lane is subtracted first, so "fit width" fits the page beside
    // the rail rather than underneath it.
    const usable = availableWidth - (isPdf ? RAIL_LANE : 0);
    // Clamped, because fitting a narrow pane to a wide page would otherwise
    // produce type too small to read, and a wide pane a page too large to scan.
    return Math.max(0.35, Math.min(3, usable / baseWidth));
  }, [zoom, availableWidth, baseWidth, isPdf]);

  /** The sheet's width: the page, plus the rail's lane when the page has none. */
  const sheetWidth = Math.round(baseWidth * scale) + (isPdf ? RAIL_LANE : 0);

  // The probe is a zero-height, full-width child of the padded track, so its
  // width IS the space a sheet may occupy — no reading of computed padding,
  // and it follows the responsive classes for free.
  useEffect(() => {
    const element = trackRef.current;
    if (!element) return;

    const report = () => setAvailableWidth(element.clientWidth);
    report();

    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /* ── VIRTUALISATION ─────────────────────────────────────────────────────── */

  const estimates = useMemo(
    () =>
      view.pages.map((page, index) => {
        if (isPdf) {
          const size = pdfSizes?.[index];
          return size ? size.height * scale : page.estimatedHeight * scale;
        }
        return page.estimatedHeight * scale;
      }),
    [view.pages, isPdf, pdfSizes, scale],
  );

  const virtual = useVirtualPages({
    count: view.pages.length,
    estimates,
    gap: PAGE_GAP,
    scrollRef,
    stackRef,
  });

  /* ── SEARCH ───────────────────────────────────────────────────────────────
   * The matching itself is `searchPages` either way, so the two paths cannot
   * produce different results. Only where it runs differs:
   *
   *   TEXT — the page text is already here; it IS the rendered content. Going
   *     to the server to search a string the browser is holding would add a
   *     round trip per keystroke for nothing.
   *   PDF — the text was deliberately not shipped (it would double the payload
   *     of a 300-page contract to populate nothing that is drawn), so the
   *     search runs on the server over the same rows.
   *
   * Either way it covers the WHOLE document, including the pages the
   * virtualiser has not mounted. That is the reason Cmd+F is taken over rather
   * than left to the browser, which can only find what is in the DOM.
   */
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [currentMatch, setCurrentMatch] = useState<number | null>(null);

  /**
   * Results, TAGGED with the query that produced them.
   *
   * Everything the search bar shows is derived from comparing that tag with
   * what is currently typed, so there is no state to clear when the query
   * changes and no window in which the count belongs to the previous word.
   * "Searching…" is simply "the results on hand are for something else".
   */
  const [results, setResults] = useState<{
    query: string;
    matches: DocumentMatch[];
    truncated: boolean;
    error: string | null;
  }>({ query: "", matches: [], truncated: false, error: null });

  const trimmedQuery = query.trim();
  const matcher = useMemo(() => compileQuery(trimmedQuery), [trimmedQuery]);
  const isSearching = matcher !== null;
  const current = isSearching && results.query === trimmedQuery ? results : null;

  const matches = current?.matches ?? EMPTY_MATCHES;
  const truncated = current?.truncated ?? false;
  const searchError = current?.error ?? null;
  const searchPending = isSearching && current === null;

  useEffect(() => {
    if (!compileQuery(trimmedQuery)) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      const finish = (
        found: DocumentMatch[],
        wasTruncated: boolean,
        error: string | null,
      ) => {
        if (cancelled) return;
        setResults({
          query: trimmedQuery,
          matches: found,
          truncated: wasTruncated,
          error,
        });
        setCurrentMatch(found.length > 0 ? 0 : null);
      };

      if (!isPdf) {
        const local = searchPages(
          view.pages.map((page) => ({
            pageNumber: page.pageNumber,
            text: page.text ?? "",
          })),
          trimmedQuery,
        );
        finish(local.matches, local.truncated, null);
        return;
      }

      void searchDocument(view.documentId, trimmedQuery).then((result) => {
        if (result.ok) finish(result.matches, result.truncated, null);
        else finish([], false, result.error);
      });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmedQuery, isPdf, view.documentId, view.pages]);

  /** Document-wide match indices, grouped by the page that holds them. */
  const matchIndicesByPage = useMemo(() => {
    const byPage = new Map<number, number[]>();
    matches.forEach((match, index) => {
      const list = byPage.get(match.pageNumber);
      if (list) list.push(index);
      else byPage.set(match.pageNumber, [index]);
    });
    return byPage;
  }, [matches]);

  const matchesByPage = useMemo(() => {
    const byPage = new Map<number, { match: DocumentMatch; index: number }[]>();
    matches.forEach((match, index) => {
      const list = byPage.get(match.pageNumber) ?? [];
      list.push({ match, index });
      byPage.set(match.pageNumber, list);
    });
    return byPage;
  }, [matches]);

  /**
   * Move to a match: scroll its page into view, then — once the page has had a
   * frame to mount — bring the mark itself into view. Two steps, because a
   * match on page 200 has no DOM to scroll to until the virtualiser has been
   * told to render page 200.
   */
  const goToMatch = useCallback(
    (index: number) => {
      const match = matches[index];
      if (!match) return;
      setCurrentMatch(index);
      virtual.scrollToPage(match.pageNumber);

      requestAnimationFrame(() => {
        const element = scrollRef.current?.querySelector(
          `[data-match-index="${index}"]`,
        );
        element?.scrollIntoView({ block: "center" });
      });
    },
    [matches, virtual],
  );

  const nextMatch = useCallback(() => {
    if (matches.length === 0) return;
    goToMatch(((currentMatch ?? -1) + 1) % matches.length);
  }, [currentMatch, goToMatch, matches.length]);

  const previousMatch = useCallback(() => {
    if (matches.length === 0) return;
    goToMatch(((currentMatch ?? 0) - 1 + matches.length) % matches.length);
  }, [currentMatch, goToMatch, matches.length]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery("");
    scrollRef.current?.focus();
  }, []);

  /* ── KEYBOARD ─────────────────────────────────────────────────────────────
   * Cmd/Ctrl+F is bound at the document level so it works wherever focus is
   * inside the pane — but NOT when the reader is typing somewhere else. A
   * shortcut stolen from a text field is a shortcut stolen from someone
   * composing a question two panes over.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "f" || !(event.metaKey || event.ctrlKey)) return;

      const active = document.activeElement;
      const typingElsewhere =
        active instanceof HTMLElement &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.isContentEditable) &&
        !scrollRef.current?.contains(active) &&
        !active.closest('[role="search"]');
      if (typingElsewhere) return;

      event.preventDefault();
      setSearchOpen(true);
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const onScrollKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const element = scrollRef.current;
      if (!element) return;

      if (event.key === "PageDown") {
        event.preventDefault();
        element.scrollTop += element.clientHeight * PAGE_KEY_OVERLAP;
      } else if (event.key === "PageUp") {
        event.preventDefault();
        element.scrollTop -= element.clientHeight * PAGE_KEY_OVERLAP;
      } else if (event.key === "Home") {
        event.preventDefault();
        virtual.scrollToPage(1);
      } else if (event.key === "End") {
        event.preventDefault();
        virtual.scrollToPage(view.pages.length);
      }
    },
    [view.pages.length, virtual],
  );

  /* ── RENDER ─────────────────────────────────────────────────────────────── */

  const visible = view.pages.slice(virtual.range.start, virtual.range.end);
  const unit = unitLabel(view.boundaries, true);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewerToolbar
        currentPage={virtual.currentPage}
        pageCount={view.pageCount}
        boundaries={view.boundaries}
        zoom={zoom}
        effectiveScale={scale}
        canZoom
        searchOpen={searchOpen}
        downloadUrl={view.downloadUrl}
        filename={view.filename}
        onGoToPage={virtual.scrollToPage}
        onZoomChange={setZoom}
        onToggleSearch={() =>
          searchOpen ? closeSearch() : setSearchOpen(true)
        }
      />

      {searchOpen ? (
        <ViewerSearchBar
          query={query}
          onQueryChange={setQuery}
          matchCount={matches.length}
          currentIndex={currentMatch}
          truncated={truncated}
          pending={searchPending}
          error={searchError}
          onNext={nextMatch}
          onPrevious={previousMatch}
          onClose={closeSearch}
        />
      ) : null}

      <div
        ref={scrollRef}
        tabIndex={0}
        onKeyDown={onScrollKeyDown}
        aria-label={`${view.title}, ${view.pageCount} ${unitLabel(view.boundaries)}s`}
        // Focusable, because that is what makes PageUp/PageDown/Home/End
        // reachable without a mouse. The focus ring is NOT suppressed: the
        // system's rule is a 2px ring on every interactive element, never
        // removed, and `:focus-visible` means a click does not draw one while
        // a Tab does — which is exactly the behaviour a scroll region wants.
        className="min-h-0 flex-1 overflow-auto bg-room"
      >
        <div className="px-4 py-6 sm:px-8 sm:py-10">
          {/* The width probe: full width of the padded track, zero height. */}
          <div ref={trackRef} className="h-0 w-full" />

          {loadError ? (
            <ErrorState
              className="mx-auto max-w-[480px]"
              title="This document could not be displayed."
              detail="The file may be corrupt, password-protected, or still uploading. You can still download the original."
              action={
                <Button asChild variant="outline" size="sm">
                  <a href={view.downloadUrl} download={view.filename}>
                    Download the file
                  </a>
                </Button>
              }
            />
          ) : (
            <PaperSheet
              className="max-w-none"
              style={{ width: sheetWidth, maxWidth: "100%" }}
              // A PDF page carries its own margins; padding the sheet as well
              // would frame the page inside the page. All it gets is the rail's
              // lane. Text has no margins of its own, so the sheet supplies
              // them and sets the measure.
              contentClassName={
                isPdf ? "py-0 pl-0 pr-[28px]" : "px-6 py-10 sm:px-12 sm:py-14"
              }
              rail={
                <EvidenceRail
                  viewportTop={virtual.viewport.top}
                  viewportHeight={virtual.viewport.height}
                />
              }
            >
              {/* ALWAYS MOUNTED for a PDF. react-pdf starts the load in an
                  effect and shows `loading` until the document is parsed, so
                  gating the stack on having page sizes would be gating it on
                  something only the stack itself can produce — the skeleton
                  would sit there forever. The skeleton belongs to <Document>,
                  not to the branch. */}
              {isPdf ? (
                <PdfStack
                  fileUrl={view.fileUrl ?? ""}
                  pages={view.pages}
                  range={virtual.range}
                  offsetOf={virtual.offsetOf}
                  totalHeight={virtual.totalHeight}
                  scale={scale}
                  stackRef={stackRef}
                  matchIndicesByPage={matchIndicesByPage}
                  matcher={matcher}
                  currentMatchIndex={currentMatch}
                  pageLabel={unit}
                  onMeasure={virtual.measure}
                  onSizes={setPdfSizes}
                  onError={setLoadError}
                  loading={
                    <PageSkeleton
                      height={view.pages[0]?.estimatedHeight ?? 1123}
                      scale={scale}
                    />
                  }
                />
              ) : (
                <div
                  ref={stackRef}
                  className="relative"
                  style={{
                    height: virtual.totalHeight,
                    // Zoom scales the type and the sheet together, so the
                    // measure stays at ~65 characters at every zoom level.
                    fontSize: TEXT_BASE_FONT_SIZE * scale,
                  }}
                >
                  {visible.map((page, offset) => {
                    const index = virtual.range.start + offset;
                    return (
                      <div
                        key={page.pageNumber}
                        className="absolute inset-x-0"
                        style={{ top: virtual.offsetOf(index) }}
                      >
                        {index > 0 ? (
                          <PageDivider label={`${unit} ${page.pageNumber}`} />
                        ) : null}
                        <TextPage
                          page={page}
                          index={index}
                          matches={matchesByPage.get(page.pageNumber) ?? []}
                          currentMatchIndex={currentMatch}
                          onMeasure={virtual.measure}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </PaperSheet>
          )}
        </div>
      </div>
    </div>
  );
}
