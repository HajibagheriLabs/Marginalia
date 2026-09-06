"use client";

import { useState, type CSSProperties } from "react";

import { CitationChip } from "@/components/citation-chip";
import { PaperSheet } from "@/components/paper-sheet";
import {
  EvidenceRail,
  type EvidenceMark,
} from "@/components/workspace/evidence-rail";
import { inkForIndex, inkVar } from "@/lib/ink";
import { SHOWCASE, SHOWCASE_PASSAGES } from "./copy";

/**
 * THE PRODUCT, RENDERED — not a screenshot and not a browser mock-up.
 *
 * This is the strongest thing the page has, so it is built out of the shipping
 * components: `PaperSheet` is the sheet the viewer uses, `EvidenceRail` is the
 * rail with its real tooltips and its real list semantics, and `CitationChip`
 * is the chip that appears inside an answer. Only the DATA is static — three
 * verbatim clauses from a document in the demo corpus and three questions from
 * the eval set, all of them in `copy.ts`.
 *
 * Which means the marketing page cannot drift from the product by accident. A
 * change to the rail's opacity rules, the chip's active state, or the paper
 * invariant lands here on the next build, and if one of those components breaks
 * the landing page breaks with it.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * IT IS LIVE, BECAUSE THE INTERACTION IS THE IDEA
 *
 * A still image of a highlight proves nothing. Selecting a mark on the rail —
 * or the citation chip beside the sheet — moves the reader to that passage, and
 * the highlight inks in with the same 220 ms wipe it uses in the workspace. The
 * `key` on the <mark> is what replays that animation: the element is a new one
 * each time, so the animation runs again rather than only on first paint.
 *
 * ONE DOCUMENT, ONE INK. All three passages come from the same source, so
 * citrine — always the first document's ink — is the only colour on the page.
 * That is the organizing law of the design system demonstrated rather than
 * explained: if it is coloured, it is a citation.
 */

/** The first document in any conversation is citrine. */
const INK = inkForIndex(0);

export function ProductDemo() {
  const [activeId, setActiveId] = useState(SHOWCASE_PASSAGES[0].id);

  const active =
    SHOWCASE_PASSAGES.find((passage) => passage.id === activeId) ??
    SHOWCASE_PASSAGES[0];

  const marks: EvidenceMark[] = SHOWCASE_PASSAGES.map((passage) => ({
    id: passage.id,
    position: passage.position,
    ink: INK,
    pageLabel: `p. ${passage.page}`,
    documentTitle: SHOWCASE.documentShortTitle,
    quotedText: passage.highlight,
    question: passage.question,
    // Age drives opacity in the rail, and "the passage you are reading" is the
    // current answer here: it is full strength, the rest fade to 40%.
    answerAge: passage.id === activeId ? 0 : 1,
  }));

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(300px,380px)] lg:gap-10">
      {/* ---- THE SHEET ---------------------------------------------------- */}
      <PaperSheet
        className="max-w-none"
        contentClassName="px-6 py-8 pr-10 sm:px-10 sm:py-10 sm:pr-14"
        rail={
          <EvidenceRail
            marks={marks}
            otherDocumentCount={0}
            // Where the reader is standing in the document. The rail spans the
            // whole document, so this band is the only thing saying which part
            // of it is on the sheet.
            viewportTop={Math.max(0, active.position - 0.09)}
            viewportHeight={0.18}
            activeMarkId={activeId}
            onSelect={setActiveId}
          />
        }
      >
        <p className="paper-label">{SHOWCASE.documentShortTitle}</p>

        {/* The clause heading is DOCUMENT text, not page structure, so it is a
            <p> carrying the weight rather than an <h3>. An <h3> here would sit
            between the page's <h1> and its first <h2>, which is a heading-level
            skip in the page outline — and the outline of a marketing page has no
            business being shaped by a contract that happens to be quoted on it. */}
        <p className="paper-body mt-3 text-[18px] font-semibold text-paper-text">
          {active.section}
        </p>

        <p className="mt-3 text-paper-text">
          {active.before}
          <mark
            /*
             * NO `animate-ink-in` HERE, and the reason is a real constraint
             * rather than a preference.
             *
             * The wipe is a `clip-path` animation, and `clip-path` on a
             * non-replaced INLINE box takes its reference box from the first
             * line fragment only: a highlight that wraps onto a second line
             * gets everything after the first line clipped away entirely. Which
             * is exactly what a real clause does — this one runs to four lines.
             *
             * The workspace does not hit this because it never wipes an inline
             * <mark>. On a PDF it paints one absolutely positioned band PER
             * LINE of the passage (see citation-overlay.tsx), and each band is
             * a block box the clip-path can wipe correctly. Reproducing that
             * here would mean measuring line boxes to decorate a marketing
             * page, so the highlight simply appears instead. The band and the
             * 2px underline are the same; only the 220 ms is missing.
             */
            className="ink-highlight text-paper-text"
            style={{ "--ink": inkVar(INK) } as CSSProperties}
          >
            {active.highlight}
          </mark>
          {active.after}
        </p>

        {/* Clear of the rail, which occupies the right 12px of the sheet plus
            its own 16px inset. */}
        <p className="num absolute right-11 bottom-5 text-mono-xs text-paper-text-muted">
          p. {active.page}
        </p>
      </PaperSheet>

      {/* ---- BESIDE IT: the answer the passage is evidence for ------------ */}
      <div className="flex flex-col gap-4">
        <p className="label">The answer it supports</p>

        {/* The question, in the same --surface container a user message gets. */}
        <p className="rounded-panel bg-surface px-3 py-2 text-body text-text">
          {active.question}
        </p>

        {/* An assistant answer gets no container: plain text on --room at a
            comfortable measure, with the chip inline exactly as it appears in
            the conversation pane. */}
        <p className="measure text-body text-text">
          {active.answer}{" "}
          <CitationChip
            marker={active.marker}
            ink={INK}
            documentTitle={SHOWCASE.documentShortTitle}
            page={active.page}
            active
            onClick={() => setActiveId(active.id)}
          />
        </p>

        <div className="flex flex-col gap-2 border-t border-edge pt-4">
          <p className="label">Cited in this conversation</p>
          {/* The chips for all three passages. Selecting one is the same action
              as selecting its mark on the rail — which is the point: the chip
              and the tick are two views of one citation.

              The chip IS the control here rather than sitting inside one: it
              already renders a <button>, and wrapping it in another would be
              invalid markup and a second tab stop for one action. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {SHOWCASE_PASSAGES.map((passage) => (
              <span key={passage.id} className="inline-flex items-center gap-1.5">
                <CitationChip
                  marker={passage.marker}
                  ink={INK}
                  documentTitle={SHOWCASE.documentShortTitle}
                  page={passage.page}
                  active={passage.id === activeId}
                  onClick={() => setActiveId(passage.id)}
                />
                <span className="num text-mono-xs text-text-muted">
                  p. {passage.page}
                </span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
