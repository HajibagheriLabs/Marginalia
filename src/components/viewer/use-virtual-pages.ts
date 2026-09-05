"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

/**
 * PAGE VIRTUALISATION.
 *
 * A 300-page PDF is 300 canvases, 300 text layers, and a few hundred megabytes
 * of bitmap if you render it. So only the pages near the viewport are mounted,
 * and the rest are empty boxes of the right height.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE SCROLLBAR MUST NOT JUMP, AND THAT IS THE HARD PART
 *
 * A virtualiser that guesses page heights and corrects them on render produces
 * the defining bug of the genre: you scroll to page 40, a page above you turns
 * out to be taller than the guess, the document grows underneath you, and the
 * text you were reading slides away. It is worse than no virtualisation.
 *
 * Two mechanisms prevent it, and which one applies depends on the format:
 *
 *   - PDF: THE HEIGHTS ARE NOT GUESSED. PDF.js can report a page's viewport
 *     without rasterising it, so every page's exact height is known before
 *     anything renders. Placeholders are the right size from the first paint
 *     and no correction ever happens.
 *   - TEXT: heights genuinely are not knowable until the text has been laid
 *     out, so `measure` corrects them — and when it corrects a page that sits
 *     ABOVE the viewport, it adjusts `scrollTop` by the same delta in the same
 *     frame. The document grows below the fold instead of under the reader.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ONE MEASUREMENT, THREE CONSUMERS
 *
 * The scroll position is read once per animation frame and feeds the render
 * window, the "page N of M" indicator, and the Evidence Rail's viewport
 * marker. Reading it three times would be three forced layouts a frame, and
 * the rail would lag the page number by a frame in a way that looks broken.
 */

/** How far beyond the viewport pages are kept mounted, as a multiple of it. */
const OVERSCAN_VIEWPORTS = 1;

/** Where in the viewport the "current page" is sampled from, top to bottom. */
const CURRENT_PAGE_PROBE = 0.3;

/** Breathing room above a page scrolled to, so it does not touch the edge. */
const SCROLL_MARGIN = 16;

export interface VirtualPages {
  /** Indices to mount: `[start, end)`. */
  range: { start: number; end: number };
  /** Height of the whole stack, including gaps. */
  totalHeight: number;
  /** Distance from the top of the stack to the top of page `index`. */
  offsetOf: (index: number) => number;
  heightOf: (index: number) => number;
  /** Report a page's real rendered height. Stable identity, safe as a dep. */
  measure: (index: number, height: number) => void;
  /** 1-based, the page the reader is looking at. */
  currentPage: number;
  scrollToPage: (pageNumber: number) => void;
  /** Fractions of the whole document, for the Evidence Rail's indicator. */
  viewport: { top: number; height: number };
}

export function useVirtualPages({
  count,
  estimates,
  gap,
  scrollRef,
  stackRef,
}: {
  count: number;
  /**
   * Height in px per page, already scaled for zoom. Identity matters: a new
   * array discards every measurement, which is correct — a zoom change
   * invalidates every height that was measured at the old scale.
   */
  estimates: number[];
  /** Vertical space between pages. */
  gap: number;
  scrollRef: RefObject<HTMLElement | null>;
  stackRef: RefObject<HTMLElement | null>;
}): VirtualPages {
  /**
   * Measured heights, tagged with the estimates they were measured against.
   *
   * Tagging rather than resetting in an effect: when `estimates` changes the
   * old measurements are simply not used, from the very first render after the
   * change. Clearing them in an effect would render one frame with heights
   * from the previous zoom level, and that frame is a visible jump.
   */
  const [measured, setMeasured] = useState<{
    source: number[];
    heights: number[];
  }>(() => ({ source: estimates, heights: estimates }));

  const heights = measured.source === estimates ? measured.heights : estimates;

  const [range, setRange] = useState({ start: 0, end: Math.min(count, 3) });
  const [currentPage, setCurrentPage] = useState(1);
  const [viewport, setViewport] = useState({ top: 0, height: 1 });
  const frameRef = useRef<number | null>(null);

  /**
   * Cumulative offsets.
   *
   * A prefix sum over a few hundred numbers costs nothing and makes both
   * "which pages are visible" and "scroll to page N" exact rather than
   * approximate. The alternative — measuring DOM positions — cannot answer for
   * pages that are not mounted, which is every page virtualisation exists for.
   */
  const offsets = useMemo(() => {
    const result = new Array<number>(count + 1);
    result[0] = 0;
    for (let index = 0; index < count; index += 1) {
      result[index + 1] =
        result[index] + (heights[index] ?? 0) + (index < count - 1 ? gap : 0);
    }
    return result;
  }, [count, gap, heights]);

  const totalHeight = offsets[count] ?? 0;

  const offsetOf = useCallback((index: number) => offsets[index] ?? 0, [offsets]);
  const heightOf = useCallback(
    (index: number) => heights[index] ?? 0,
    [heights],
  );

  /** The page whose span contains `position`. Binary search over the offsets. */
  const indexAt = useCallback(
    (position: number) => {
      let low = 0;
      let high = count - 1;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (offsets[middle + 1] <= position) low = middle + 1;
        else high = middle;
      }
      return Math.max(0, low);
    },
    [count, offsets],
  );

  const sync = useCallback(() => {
    const scrollElement = scrollRef.current;
    const stackElement = stackRef.current;
    if (!scrollElement || !stackElement || count === 0) return;

    // The stack sits inside the sheet, inside the padded scroll container, so
    // its offset within the scrolled content is not zero. Comparing rects is
    // immune to however that padding happens to be composed.
    const stackTop =
      stackElement.getBoundingClientRect().top -
      scrollElement.getBoundingClientRect().top;
    const visibleTop = -stackTop;
    const viewportHeight = scrollElement.clientHeight;
    const overscan = viewportHeight * OVERSCAN_VIEWPORTS;

    const start = indexAt(Math.max(0, visibleTop - overscan));
    const end = Math.min(
      count,
      indexAt(visibleTop + viewportHeight + overscan) + 1,
    );
    setRange((previous) =>
      previous.start === start && previous.end === end
        ? previous
        : { start, end },
    );

    setCurrentPage(
      indexAt(Math.max(0, visibleTop + viewportHeight * CURRENT_PAGE_PROBE)) + 1,
    );

    const total = offsets[count] || 1;
    setViewport({
      top: Math.max(0, Math.min(1, visibleTop / total)),
      height: Math.max(0.02, Math.min(1, viewportHeight / total)),
    });
  }, [count, indexAt, offsets, scrollRef, stackRef]);

  /**
   * The values `measure` needs, refreshed after every render.
   *
   * `measure` is passed to every mounted page and lands in a ResizeObserver
   * effect's dependency list, so its identity has to be stable — a new
   * function each render would tear down and rebuild every observer on every
   * height change, which is exactly the churn this hook exists to avoid.
   * Assignment happens in an effect rather than during render, so nothing here
   * reads or writes a ref while React is rendering.
   */
  const latest = useRef({ heights, offsets, estimates });
  useEffect(() => {
    latest.current = { heights, offsets, estimates };
  });

  /**
   * Record a page's real height.
   *
   * The scroll compensation is the whole reason this is not a plain setState:
   * when a page that has already been scrolled past turns out to be taller
   * than its placeholder, everything below it moves down, including whatever
   * the reader is looking at. Adding the same delta to `scrollTop` in the same
   * frame cancels that exactly.
   */
  const measure = useCallback(
    (index: number, height: number) => {
      const current = latest.current;
      const previous = current.heights[index] ?? 0;
      // Sub-pixel churn from a ResizeObserver would otherwise loop forever.
      if (Math.abs(previous - height) < 1) return;

      const scrollElement = scrollRef.current;
      const stackElement = stackRef.current;
      if (scrollElement && stackElement) {
        const stackTop =
          stackElement.getBoundingClientRect().top -
          scrollElement.getBoundingClientRect().top;
        const pageBottom = (current.offsets[index] ?? 0) + previous;
        if (pageBottom <= -stackTop) {
          scrollElement.scrollTop += height - previous;
        }
      }

      setMeasured((state) => {
        const base =
          state.source === current.estimates ? state.heights : current.estimates;
        if (Math.abs((base[index] ?? 0) - height) < 1) return state;
        const next = base.slice();
        next[index] = height;
        return { source: current.estimates, heights: next };
      });
    },
    [scrollRef, stackRef],
  );

  const scrollToPage = useCallback(
    (pageNumber: number) => {
      const scrollElement = scrollRef.current;
      const stackElement = stackRef.current;
      if (!scrollElement || !stackElement) return;

      const index = Math.max(0, Math.min(count - 1, pageNumber - 1));
      const stackTop =
        stackElement.getBoundingClientRect().top -
        scrollElement.getBoundingClientRect().top;

      scrollElement.scrollTop +=
        stackTop + (offsets[index] ?? 0) - SCROLL_MARGIN;
    },
    [count, offsets, scrollRef, stackRef],
  );

  // One rAF-throttled listener. A fast scroll cannot queue more state updates
  // than there are frames to paint them.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const onScroll = () => {
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        sync();
      });
    };

    onScroll();
    element.addEventListener("scroll", onScroll, { passive: true });

    // The conversation pane is resizable and the window is not, so a
    // ResizeObserver is the only thing that catches a drag on its edge.
    const observer = new ResizeObserver(onScroll);
    observer.observe(element);

    return () => {
      element.removeEventListener("scroll", onScroll);
      observer.disconnect();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [scrollRef, sync]);

  return {
    range: { start: range.start, end: Math.min(range.end, count) },
    totalHeight,
    offsetOf,
    heightOf,
    measure,
    currentPage: Math.max(1, Math.min(Math.max(count, 1), currentPage)),
    scrollToPage,
    viewport,
  };
}
