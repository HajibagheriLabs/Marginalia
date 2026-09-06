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
 * THE EVIDENCE RAIL — the element this application is remembered by.
 *
 * A 12px strip down the right edge of the paper sheet, spanning the WHOLE
 * document rather than the visible viewport: a minimap, not a scrollbar. Every
 * passage cited anywhere in this conversation leaves a tick at its page, in its
 * source document's ink. A document you have been asking about slowly becomes a
 * record of the conversation you had over it.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT THE RAIL IS SAYING
 *
 * Opacity is AGE. Marks from the most recent answer are full strength; earlier
 * ones fade to 40%. The rail is therefore readable at a glance as "here is
 * what this answer rests on, in the context of everything I have asked".
 *
 * Colour is SOURCE, exactly as it is on the chips — the same positional ink,
 * from the same array. When a conversation searches several documents the rail
 * shows only the one on screen, and a mono count says how much evidence is
 * sitting in the others. Mixing documents into one strip would make position
 * meaningless: page 40 of a 50-page contract and page 40 of a 300-page
 * guideline are nowhere near each other.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * IT APPEARS ONLY WHEN THERE IS EVIDENCE
 *
 * An empty rail is a decoration, and this design system does not have any. A
 * document nobody has asked about yet shows no strip at all.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * IT IS A LIST, NOT A DECORATION
 *
 * Screen readers get a real `<ul>` of buttons, each announcing its page and
 * its source document, each reachable by Tab and activated by Enter. The
 * viewport indicator is `aria-hidden` because "where you are scrolled to" is
 * not information a screen reader user needs read to them.
 */

export interface EvidenceMark {
  id: string;
  /** 0–1: where in the WHOLE document this passage sits. */
  position: number;
  ink: InkName;
  pageLabel: string;
  documentTitle: string;
  /** The passage itself, for the hover and focus preview. */
  quotedText: string | null;
  /** The question the answer containing it was given to. */
  question: string;
  /** 0 for the most recent answer. Drives opacity. */
  answerAge: number;
}

export function EvidenceRail({
  marks,
  /** Citations in the conversation's OTHER documents. Zero hides the count. */
  otherDocumentCount,
  viewportTop,
  viewportHeight,
  activeMarkId,
  onSelect,
  className,
}: {
  marks: EvidenceMark[];
  otherDocumentCount: number;
  /** 0–1, fraction of the document above the viewport. */
  viewportTop: number;
  /** 0–1, fraction of the document the viewport covers. */
  viewportHeight: number;
  activeMarkId: string | null;
  onSelect: (markId: string) => void;
  className?: string;
}) {
  // Nothing has been cited anywhere in this conversation. No strip, no track,
  // no empty gesture at the edge of the page.
  if (marks.length === 0 && otherDocumentCount === 0) return null;

  return (
    <div className={cn("flex h-full flex-col items-center gap-1.5", className)}>
      <div className="relative w-3 flex-1 rounded-chip bg-paper-edge/50">
        {/* Where you are in the document. A neutral paper tone, never an ink —
            the inks in this strip must only ever mean "a citation is here". */}
        <div
          aria-hidden
          className="absolute inset-x-0 rounded-chip bg-paper-text/10"
          style={{
            top: `${clamp(viewportTop) * 100}%`,
            height: `${Math.max(0.04, Math.min(1, viewportHeight)) * 100}%`,
          }}
        />

        {/* A real list, positioned as a real box. `display: contents` would be
            tidier CSS and would strip the list semantics in several browsers —
            which would turn the rail back into decoration for exactly the
            people the list is for. */}
        <ul aria-label="Cited passages" className="absolute inset-0">
          {marks.map((mark) => (
            <li
              key={mark.id}
              className="absolute inset-x-0"
              style={{ top: `calc(${clamp(mark.position) * 100}% - 1px)` }}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => onSelect(mark.id)}
                    aria-label={`${mark.pageLabel} of ${mark.documentTitle}`}
                    aria-current={mark.id === activeMarkId ? "true" : undefined}
                    style={{ background: inkVar(mark.ink) } as CSSProperties}
                    className={cn(
                      "animate-mark-in block w-auto rounded-chip",
                      // The active mark is thicker and reaches past the strip,
                      // so the one you just clicked is findable without colour
                      // having to carry two meanings at once.
                      mark.id === activeMarkId
                        ? "-mx-1 h-1.5 opacity-100"
                        : mark.answerAge === 0
                          ? "h-0.5 opacity-100"
                          : "h-0.5 opacity-40",
                      "hover:opacity-100 focus-visible:opacity-100",
                    )}
                  />
                </TooltipTrigger>

                <TooltipContent
                  side="left"
                  align="center"
                  className="max-w-[340px] overflow-hidden border-edge bg-surface-raised p-0"
                >
                  <div className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="truncate text-body-sm font-medium text-text">
                      {mark.documentTitle}
                    </span>
                    <span className="num shrink-0 text-mono-xs text-text-faint">
                      {mark.pageLabel}
                    </span>
                  </div>

                  {mark.quotedText ? (
                    // The passage, on paper. A fragment of the page lifted off
                    // the sheet — the same treatment the chip preview gets.
                    <p className="max-h-[160px] overflow-hidden border-t border-edge bg-paper px-3 py-2.5 font-serif text-[15px] leading-[1.55] text-paper-text">
                      {mark.quotedText}
                    </p>
                  ) : null}

                  {/* What this passage was evidence FOR. Without it the rail is
                      a list of places; with it, it is a record of a
                      conversation. */}
                  <p className="border-t border-edge px-3 py-2 text-body-sm text-text-muted">
                    Answering: {mark.question}
                  </p>
                </TooltipContent>
              </Tooltip>
            </li>
          ))}
        </ul>
      </div>

      {otherDocumentCount > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              // Focusable but not interactive: the WAI pattern for putting a
              // tooltip on a piece of information. There is nothing to
              // activate — the count is a fact, and its whole content is in
              // the label for anyone who cannot hover.
              tabIndex={0}
              aria-label={`${otherDocumentCount} more cited ${
                otherDocumentCount === 1 ? "passage" : "passages"
              } in the conversation's other documents`}
              className="num -mx-1.5 shrink-0 rounded-control px-1 text-mono-xs whitespace-nowrap text-paper-text-muted"
            >
              +{otherDocumentCount}
            </span>
          </TooltipTrigger>
          <TooltipContent side="left" className="max-w-[240px]">
            {otherDocumentCount} cited{" "}
            {otherDocumentCount === 1 ? "passage" : "passages"} in the other
            documents this conversation searches. Open one to see its marks.
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
