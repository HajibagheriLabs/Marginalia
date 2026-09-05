"use client";

import type { CSSProperties } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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

/**
 * A chip with the passage it points at, shown on hover and on focus.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THE PREVIEW IS PAPER
 *
 * The panel is a popover, so it carries --shadow-overlay: that is what a
 * floating surface is, and the sheet's shadow belongs to the one lifted thing
 * in the application. But the QUOTE inside it is document text, so it is set on
 * --paper in Source Serif at document size. The reader is looking at a
 * fragment of the page, and it should look like one — that is the whole promise
 * a citation makes.
 *
 * Built on Tooltip rather than HoverCard because a Tooltip opens on FOCUS as
 * well as hover. A preview only a mouse can reach is a preview half the people
 * using this cannot see.
 */
export function CitationChipWithPreview({
  quotedText,
  documentTitle,
  pageFrom,
  pageTo,
  ...chip
}: Parameters<typeof CitationChip>[0] & {
  quotedText: string | null;
  documentTitle: string;
  pageFrom: number;
  pageTo: number;
}) {
  const pages =
    pageFrom === pageTo ? `p. ${pageFrom}` : `pp. ${pageFrom}–${pageTo}`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <CitationChip {...chip} documentTitle={documentTitle} page={pageFrom} />
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="start"
        className="max-w-[380px] overflow-hidden border-edge bg-surface-raised p-0"
      >
        <div className="flex items-center justify-between gap-3 px-3 py-2">
          <span className="truncate text-body-sm font-medium text-text">
            {documentTitle}
          </span>
          <span className="num shrink-0 text-mono-xs text-text-faint">
            {pages}
          </span>
        </div>

        {quotedText ? (
          <p className="max-h-[220px] overflow-hidden border-t border-edge bg-paper px-3 py-2.5 font-serif text-[15px] leading-[1.6] text-paper-text">
            {quotedText}
          </p>
        ) : (
          // The chunk was replaced by a re-ingestion and the quote was never
          // stored. Say that, rather than showing an empty sheet.
          <p className="border-t border-edge px-3 py-2.5 text-body-sm text-text-muted">
            This passage is no longer stored with the answer.
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
