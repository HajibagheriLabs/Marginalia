"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { PaperSheet } from "@/components/paper-sheet";
import { EvidenceRail } from "@/components/workspace/evidence-rail";

/**
 * The reading pane's scroll container: the dark table, with the paper sheet
 * lying on it.
 *
 * This is a client component for exactly one reason — the Evidence Rail's
 * viewport indicator has to know where in the document you are, which means
 * owning the scroll element. The document content itself is passed in as
 * children and stays server-rendered.
 *
 * Scroll is measured in a rAF so a fast scroll cannot queue up more state
 * updates than there are frames to paint them.
 */
export function ReadingSurface({ children }: { children: React.ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 1 });

  const measure = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const { scrollTop, scrollHeight, clientHeight } = element;
    if (scrollHeight <= 0) return;
    setViewport({
      top: scrollTop / scrollHeight,
      height: clientHeight / scrollHeight,
    });
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const onScroll = () => {
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        measure();
      });
    };

    measure();
    element.addEventListener("scroll", onScroll, { passive: true });

    // The pane is resizable and the window is not, so a ResizeObserver is the
    // only thing that catches a drag on the conversation pane's edge.
    const observer = new ResizeObserver(measure);
    observer.observe(element);

    return () => {
      element.removeEventListener("scroll", onScroll);
      observer.disconnect();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [measure]);

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto bg-room px-4 py-6 sm:px-8 sm:py-10"
    >
      <PaperSheet
        rail={
          <EvidenceRail
            viewportTop={viewport.top}
            viewportHeight={viewport.height}
          />
        }
      >
        {children}
      </PaperSheet>
    </div>
  );
}
