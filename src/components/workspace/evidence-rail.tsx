"use client";

import type { CSSProperties } from "react";

import { inkVar, type InkName } from "@/lib/ink";
import { cn } from "@/lib/utils";

export interface EvidenceMark {
  id: string;
  /** 0–1: where in the WHOLE document this passage sits. */
  position: number;
  ink: InkName;
  /** Marks from the current answer are full opacity; older ones fade. */
  current?: boolean;
  label: string;
}

/**
 * THE EVIDENCE RAIL — the element this application is remembered by.
 *
 * A 12px strip down the right edge of the paper sheet, spanning the WHOLE
 * document rather than the visible viewport: a minimap, not a scrollbar. Every
 * passage cited in this conversation leaves a tick in its source document's ink
 * colour, so a document you have been asking about slowly becomes a record of
 * the conversation you had over it.
 *
 * At this stage the rail has no marks — nothing has been cited because there is
 * no retrieval yet — so what renders is the track and the viewport indicator.
 * The mark rendering is here and correct; it simply has nothing to draw. That
 * is deliberate: the geometry is the hard part and it is settled now, while the
 * pane around it is being sized.
 *
 * Everything else in the reading pane is kept quiet so this strip can be loud.
 */
export function EvidenceRail({
  marks = [],
  viewportTop,
  viewportHeight,
  onSelect,
  className,
}: {
  marks?: EvidenceMark[];
  /** 0–1, fraction of the document above the viewport. */
  viewportTop: number;
  /** 0–1, fraction of the document the viewport covers. */
  viewportHeight: number;
  onSelect?: (mark: EvidenceMark) => void;
  className?: string;
}) {
  return (
    <div
      aria-hidden={marks.length === 0}
      aria-label="Cited passages"
      className={cn(
        "relative h-full w-3 rounded-chip bg-paper-edge/50",
        className,
      )}
    >
      {/* Where you are in the document. A neutral paper tone, never an ink —
          the inks in this strip must only ever mean "a citation is here". */}
      <div
        className="absolute inset-x-0 rounded-chip bg-paper-text/10"
        style={{
          top: `${Math.max(0, Math.min(1, viewportTop)) * 100}%`,
          height: `${Math.max(0.04, Math.min(1, viewportHeight)) * 100}%`,
        }}
      />

      {marks.map((mark) => (
        <button
          key={mark.id}
          type="button"
          title={mark.label}
          aria-label={mark.label}
          onClick={() => onSelect?.(mark)}
          style={
            {
              top: `calc(${Math.max(0, Math.min(1, mark.position)) * 100}% - 1px)`,
              background: inkVar(mark.ink),
            } as CSSProperties
          }
          className={cn(
            "animate-mark-in absolute inset-x-0 h-0.5 rounded-chip",
            mark.current ? "opacity-100" : "opacity-40",
          )}
        />
      ))}
    </div>
  );
}
