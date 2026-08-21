"use client";

import type { CSSProperties } from "react";

import { inkVar, type InkName } from "@/lib/ink";
import { cn } from "@/lib/utils";

/**
 * A citation marker in the conversation: a mono number in a 12% ink tint behind
 * a 1px full-strength ink border.
 *
 * This is the first coloured thing in the application and, along with the
 * highlight band on the page, the only one. The chip and the passage it points
 * at share an ink, so the eye can travel from an answer to the page without
 * reading anything.
 *
 * The ink is passed in, not derived here: it belongs to the SOURCE DOCUMENT and
 * is assigned positionally per conversation (see src/lib/ink.ts). A chip must
 * never pick its own colour, or two chips citing the same document could end up
 * different colours in the same answer.
 */
export function CitationChip({
  marker,
  ink,
  documentTitle,
  page,
  onClick,
  active = false,
  className,
}: {
  /** The number rendered in the answer text, e.g. [3]. */
  marker: number;
  ink: InkName;
  /** Announced to screen readers so the chip is not just "3". */
  documentTitle?: string;
  page?: number;
  onClick?: () => void;
  /** The chip belonging to the passage currently lit on the page. */
  active?: boolean;
  className?: string;
}) {
  const description = [
    `Citation ${marker}`,
    documentTitle,
    page ? `page ${page}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={description}
      data-active={active || undefined}
      style={{ "--ink": inkVar(ink) } as CSSProperties}
      className={cn(
        "ink-chip inline-flex h-[18px] min-w-[18px] items-center justify-center px-1.5 align-baseline",
        // The active chip fills to its ink; the marker flips to paper-dark so
        // it stays legible on a light highlighter colour.
        "data-[active]:bg-[var(--ink)] data-[active]:text-paper-text",
        onClick ? "cursor-pointer" : "cursor-default",
        className,
      )}
    >
      {marker}
    </button>
  );
}
