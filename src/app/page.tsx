import type { CSSProperties } from "react";

import { ThemeToggle } from "@/components/theme-toggle";
import { APP_NAME, APP_TAGLINE } from "@/lib/brand";

/**
 * Placeholder home page. Its only job right now is to prove the design system
 * is wired: all three faces, both room themes, the invariant paper sheet, both
 * shadow tokens, and one highlighter ink. It gets replaced by the marketing
 * page and the workspace as those get built.
 */

const inks = [
  { name: "citrine", token: "var(--ink-citrine)" },
  { name: "rose", token: "var(--ink-rose)" },
  { name: "jade", token: "var(--ink-jade)" },
  { name: "azure", token: "var(--ink-azure)" },
] as const;

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col gap-8 px-6 py-14">
      <header className="flex items-start justify-between gap-6">
        <div className="flex flex-col gap-3">
          <p className="label">Design system check</p>
          {/* Display type is set in the sans face — the serif belongs to
              documents, not to marketing. */}
          <h1 className="max-w-[16ch] text-display font-sans">{APP_NAME}</h1>
          <p className="max-w-[52ch] text-body text-text-muted">{APP_TAGLINE}</p>
        </div>
        <ThemeToggle />
      </header>

      <div className="grid flex-1 gap-6 lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)]">
        {/* ---- ROOM: a panel on the workspace surface --------------------- */}
        <section className="flex flex-col gap-5 rounded-panel border border-edge bg-surface p-5">
          <div className="flex flex-col gap-1">
            <p className="label">Room</p>
            <h2 className="text-page-title">Conversation</h2>
          </div>

          <p className="text-body text-text-muted">
            Interface text is Public Sans. Chrome is monochrome — buttons,
            navigation, links, and tabs carry no colour at all.
          </p>

          {/* Numbers and identifiers are always mono, always tabular. */}
          <dl className="flex flex-col gap-2 border-t border-edge pt-4">
            {[
              ["Chunks retrieved", "8"],
              ["Fused RRF score", "0.0164"],
              ["Latency", "1,284 ms"],
              ["Model", "claude-sonnet-5"],
            ].map(([term, value]) => (
              <div key={term} className="flex items-baseline justify-between gap-4">
                <dt className="text-body-sm text-text-faint">{term}</dt>
                <dd className="num text-mono-sm text-text">{value}</dd>
              </div>
            ))}
          </dl>

          {/* The four inks are the entire chromatic vocabulary. One is
              assigned per source document, cycling in this order. */}
          <div className="flex flex-col gap-2 border-t border-edge pt-4">
            <p className="label">Citation chips</p>
            <div className="flex flex-wrap gap-2">
              {inks.map((ink, index) => (
                <span
                  key={ink.name}
                  className="ink-chip px-2 py-0.5"
                  style={{ "--ink": ink.token } as CSSProperties}
                >
                  {index + 1}
                </span>
              ))}
            </div>
          </div>

          {/* --shadow-overlay: the second and last shadow in the system. */}
          <div className="flex flex-col gap-2 border-t border-edge pt-4">
            <p className="label">Overlay shadow</p>
            <div className="rounded-panel border border-edge bg-surface-raised p-3 shadow-overlay">
              <p className="text-body-sm">
                Popovers, dialogs, drawers, and toasts. Everything else is a 1px
                hairline.
              </p>
            </div>
          </div>
        </section>

        {/* ---- PAPER: the lit sheet on the table -------------------------- */}
        <section className="flex flex-col gap-3">
          <p className="label">Paper — identical in both themes</p>

          <article className="paper-sheet relative flex-1 px-10 py-9 pr-14">
            {/* The label style, re-tinted for paper: the `.label` utility uses
                a room token, which has no business on the sheet. */}
            <p className="text-[11px] leading-[1.4] font-semibold tracking-[0.07em] text-paper-text-muted uppercase">
              Master Services Agreement
            </p>

            <h2 className="paper-body mt-4 text-[19px] font-semibold">
              7. Termination
            </h2>

            <p className="paper-body mt-3 text-paper-text">
              Either party may terminate this Agreement for convenience upon{" "}
              {/* One citation, inked in citrine — the only colour on the page. */}
              <mark
                className="ink-highlight text-paper-text"
                style={{ "--ink": "var(--ink-citrine)" } as CSSProperties}
              >
                sixty (60) days prior written notice
              </mark>{" "}
              to the other party. Termination shall not relieve either party of
              obligations accrued prior to the effective date of termination,
              including any amounts then due and payable.
            </p>

            <p className="paper-body mt-4 text-paper-text-muted">
              Document body text is Source Serif 4 at 17px, set larger than the
              interface on purpose: this is the part you actually read.
            </p>

            {/* Page numbers are mono, like every other number. */}
            <p className="num absolute right-6 bottom-6 text-mono-xs text-paper-text-muted">
              p. 14
            </p>

            {/* A stand-in for the Evidence Rail: a 12px strip down the right
                edge of the sheet, one tick per cited passage. */}
            <div
              aria-hidden
              className="absolute inset-y-4 right-2 w-3 rounded-chip bg-paper-edge/60"
            >
              <span
                className="absolute left-0 h-1 w-full rounded-chip"
                style={
                  {
                    top: "22%",
                    background: "var(--ink-citrine)",
                  } as CSSProperties
                }
              />
            </div>
          </article>
        </section>
      </div>
    </main>
  );
}
