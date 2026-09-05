"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Download,
  Minus,
  Plus,
  Search,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { unitLabel, type PageBoundaries } from "@/lib/viewer/types";
import { cn } from "@/lib/utils";

/**
 * THE VIEWER CONTROLS.
 *
 * Monochrome and quiet, on the room rather than on the paper: these belong to
 * the tool, not to the document. Nothing here is coloured, nothing animates,
 * and every number in it is mono — page counts and zoom percentages are
 * numbers, and numbers are set in JetBrains Mono everywhere in this
 * application.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * IT SAYS "BLOCK" FOR A WORD DOCUMENT
 *
 * A DOCX has no pages. The extractor invented boundaries at roughly a printed
 * page of prose so that a citation could point at something narrower than "the
 * document", and calling those "pages" in the interface would be the tool
 * claiming a precision the source does not have — "page 14" of a Word file
 * means nothing to the person who wrote it. `unitLabel` is the single place
 * that decision is made.
 */

export const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;

export type ZoomSetting = number | "fit";

export function ViewerToolbar({
  currentPage,
  pageCount,
  boundaries,
  zoom,
  effectiveScale,
  canZoom,
  searchOpen,
  downloadUrl,
  filename,
  onGoToPage,
  onZoomChange,
  onToggleSearch,
}: {
  currentPage: number;
  pageCount: number;
  boundaries: PageBoundaries;
  zoom: ZoomSetting;
  /** What "fit" currently resolves to, for the percentage readout. */
  effectiveScale: number;
  /** Text documents scale their type; PDFs scale their raster. Both zoom. */
  canZoom: boolean;
  searchOpen: boolean;
  downloadUrl: string;
  filename: string;
  onGoToPage: (pageNumber: number) => void;
  onZoomChange: (zoom: ZoomSetting) => void;
  onToggleSearch: () => void;
}) {
  const unit = unitLabel(boundaries, true);

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-edge bg-room px-2">
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={currentPage <= 1}
        onClick={() => onGoToPage(currentPage - 1)}
        aria-label={`Previous ${unitLabel(boundaries)}`}
      >
        <ChevronUp aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={currentPage >= pageCount}
        onClick={() => onGoToPage(currentPage + 1)}
        aria-label={`Next ${unitLabel(boundaries)}`}
      >
        <ChevronDown aria-hidden />
      </Button>

      <PageJump
        currentPage={currentPage}
        pageCount={pageCount}
        unit={unit}
        onGoToPage={onGoToPage}
      />

      <div className="flex-1" />

      {canZoom ? (
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={effectiveScale <= ZOOM_STEPS[0]}
            onClick={() => onZoomChange(stepZoom(effectiveScale, -1))}
            aria-label="Zoom out"
          >
            <Minus aria-hidden />
          </Button>

          {/* Clicking the percentage returns to 100%, which is the shortcut
              people reach for and the one most viewers hide in a menu. */}
          <button
            type="button"
            onClick={() => onZoomChange(1)}
            aria-label="Reset zoom to 100 percent"
            className="num rounded-control px-1.5 py-0.5 text-mono-xs text-text-muted tabular-nums hover:text-text"
          >
            {Math.round(effectiveScale * 100)}%
          </button>

          <Button
            variant="ghost"
            size="icon-sm"
            disabled={effectiveScale >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
            onClick={() => onZoomChange(stepZoom(effectiveScale, 1))}
            aria-label="Zoom in"
          >
            <Plus aria-hidden />
          </Button>

          <button
            type="button"
            onClick={() => onZoomChange("fit")}
            aria-pressed={zoom === "fit"}
            className={cn(
              "rounded-control px-1.5 py-0.5 text-mono-xs hover:text-text",
              zoom === "fit" ? "text-text" : "text-text-muted",
            )}
          >
            Fit width
          </button>

          <span aria-hidden className="mx-1 h-4 w-px bg-edge" />
        </>
      ) : null}

      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onToggleSearch}
        aria-pressed={searchOpen}
        aria-label="Search this document"
      >
        <Search aria-hidden />
      </Button>

      <Button asChild variant="ghost" size="icon-sm">
        {/* The original file, exactly as it was uploaded. `download` names it
            with the filename the reader recognises rather than the blob's. */}
        <a href={downloadUrl} download={filename} aria-label="Download the original file">
          <Download aria-hidden />
        </a>
      </Button>
    </div>
  );
}

/**
 * "Page 14 of 312" — where 14 is an input.
 *
 * A jump-to-page box that is also the indicator, rather than a separate
 * control: in a 300-page document the number you want to change is the number
 * you are already looking at.
 *
 * The field holds a DRAFT while it is focused. Committing on every keystroke
 * would scroll to page 3 on the way to typing 312, and re-syncing to the
 * scroll position while someone is mid-type would delete what they wrote.
 */
function PageJump({
  currentPage,
  pageCount,
  unit,
  onGoToPage,
}: {
  currentPage: number;
  pageCount: number;
  unit: string;
  onGoToPage: (pageNumber: number) => void;
}) {
  /**
   * The draft is TAGGED with the page it was started from, rather than being
   * cleared whenever the page changes. Same result, no effect: scrolling moves
   * `currentPage`, the tag stops matching, and the field falls straight back to
   * showing where the reader actually is. Typing does not move `currentPage`,
   * so a half-typed "31" on the way to "312" survives.
   */
  const [draft, setDraft] = useState<{ page: number; value: string } | null>(
    null,
  );
  const value = draft?.page === currentPage ? draft.value : String(currentPage);

  function commit(raw: string) {
    const parsed = Number.parseInt(raw, 10);
    setDraft(null);
    if (!Number.isFinite(parsed)) return;
    onGoToPage(Math.max(1, Math.min(pageCount, parsed)));
  }

  return (
    <div className="ml-1 flex items-center gap-1.5">
      <label htmlFor="viewer-page" className="sr-only">
        {unit} number
      </label>
      <input
        id="viewer-page"
        inputMode="numeric"
        value={value}
        onChange={(event) =>
          setDraft({
            page: currentPage,
            value: event.target.value.replace(/[^\d]/g, ""),
          })
        }
        onFocus={(event) => event.currentTarget.select()}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(null);
            event.currentTarget.blur();
          }
        }}
        className={cn(
          "num h-6 w-10 rounded-control border border-edge bg-surface px-1 text-center text-mono-xs text-text tabular-nums",
          "hover:border-edge-strong",
        )}
      />
      <span className="num text-mono-xs whitespace-nowrap text-text-faint tabular-nums">
        of {pageCount}
      </span>
    </div>
  );
}

/** The next zoom step in `direction`, from wherever the current scale sits. */
function stepZoom(current: number, direction: 1 | -1): number {
  if (direction === 1) {
    return ZOOM_STEPS.find((step) => step > current + 0.001) ?? current;
  }
  return (
    [...ZOOM_STEPS].reverse().find((step) => step < current - 0.001) ?? current
  );
}
