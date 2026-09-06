import type { CSSProperties } from "react";

import { CitationChip } from "@/components/citation-chip";
import { PaperSheet } from "@/components/paper-sheet";
import { inkForIndex, inkVar } from "@/lib/ink";
import { REFUSAL, SHOWCASE, SHOWCASE_PASSAGES } from "./copy";

/**
 * THE TWO STATIC EXHIBITS.
 *
 * The third one — the retrieval trace — needs no wrapper at all: the landing
 * page renders `RetrievalTrace` itself with static rows, which is the strongest
 * possible version of "an honest visual".
 *
 * Both of these are built from the shipping pieces too: `PaperSheet` for the
 * page, `CitationChip` for the marker, the `.ink-highlight` band for the
 * citation, and the refusal sentence imported from the prompt module.
 */

const INK = inkForIndex(0);

/**
 * GROUNDED ANSWERS — a citation chip and the passage it points to.
 *
 * The chip is inert here, and that is a deliberate difference from the hero: it
 * has no `onClick`, so it renders with a default cursor and does not pretend to
 * be a control on a page with nowhere to scroll to.
 */
export function GroundedExhibit() {
  const passage = SHOWCASE_PASSAGES[0];

  return (
    <div className="flex flex-col gap-4">
      <p className="measure text-body text-text">
        {passage.answer}{" "}
        <CitationChip
          marker={passage.marker}
          ink={INK}
          documentTitle={SHOWCASE.documentShortTitle}
          page={passage.page}
        />
      </p>

      {/* The arrow the chip makes, drawn as the thing it points at. */}
      <PaperSheet
        className="max-w-none"
        contentClassName="px-5 py-5 sm:px-7 sm:py-6"
      >
        <p className="paper-label">
          {SHOWCASE.documentShortTitle} · {passage.section}
        </p>
        <p className="mt-3 text-[15px] leading-[1.6] text-paper-text">
          <mark
            className="ink-highlight text-paper-text"
            style={{ "--ink": inkVar(INK) } as CSSProperties}
          >
            {passage.highlight}
          </mark>
        </p>
        <p className="num mt-3 text-mono-xs text-paper-text-muted">
          p. {passage.page}
        </p>
      </PaperSheet>
    </div>
  );
}

/**
 * IT SAYS WHEN IT DOESN'T KNOW — a real refusal.
 *
 * The sentence comes from `noContextAnswer` in the prompt module via `copy.ts`,
 * so it is the exact string the product writes into the message row. The mono
 * footer underneath is the metadata that answer actually carries: no model was
 * called, so `model` is null and `finish_reason` is `no-context`.
 */
export function RefusalExhibit() {
  return (
    <div className="flex flex-col gap-4 rounded-panel border border-edge bg-surface p-5">
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-panel bg-surface-raised px-3 py-2 text-body text-text">
          {REFUSAL.question}
        </p>
      </div>

      {/* An assistant answer gets no container. This one is a whole sentence
          the product knows in advance, which is why no model is asked for it. */}
      <p className="measure text-body text-text">{REFUSAL.answer}</p>

      <p className="num text-mono-xs text-text-faint">
        model: none · finish_reason: no-context · 0 passages above the floor
      </p>

      <p className="border-t border-edge pt-3 text-body-sm text-text-muted">
        {REFUSAL.footnote}
      </p>
    </div>
  );
}
