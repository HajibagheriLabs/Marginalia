import type { DocumentStatus } from "@/db/schema";
import { DOCUMENT_STATUS_META, type StatusTone } from "@/lib/document-status";
import { cn } from "@/lib/utils";

/**
 * A 6px dot carrying one document's ingestion state.
 *
 * This is one of only two places in the interface allowed to show colour that
 * is not a highlighter ink — the SYSTEM STATE tokens. The separation holds
 * because the palettes cannot be confused: --warn is amber-orange and citrine
 * ink is yellow; --ok is a desaturated green and jade ink is mint. And a 6px
 * dot in the rail is never adjacent to a citation.
 *
 * `uploaded` is drawn hollow rather than filled: nothing has happened to the
 * document yet, and an empty ring reads as "waiting" without spending a colour.
 * Nothing pulses — no in-progress state animates, because the motion budget in
 * this design system is spent entirely on streaming and citations.
 */

const TONE_CLASS: Record<StatusTone, string> = {
  neutral: "border border-text-faint bg-transparent",
  progress: "bg-warn",
  ready: "bg-ok",
  failed: "bg-danger",
};

export function StatusDot({
  status,
  className,
  /** Renders the status word next to the dot instead of only for screen readers. */
  showLabel = false,
  /**
   * Set false when the caller already renders the status word nearby — two
   * copies of "Extracting text" in one row is noise in a screen reader.
   */
  srLabel = true,
}: {
  status: DocumentStatus;
  className?: string;
  showLabel?: boolean;
  srLabel?: boolean;
}) {
  const meta = DOCUMENT_STATUS_META[status];

  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span
        aria-hidden
        data-status={status}
        className={cn(
          "size-1.5 shrink-0 rounded-chip",
          TONE_CLASS[meta.tone],
        )}
      />
      {showLabel || srLabel ? (
        <span className={showLabel ? "text-body-sm text-text-muted" : "sr-only"}>
          {meta.label}
        </span>
      ) : null}
    </span>
  );
}
