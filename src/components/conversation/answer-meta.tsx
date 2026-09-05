"use client";

import type { AnswerMetadata } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

/**
 * The quiet footer under an answer: what served it, and what it cost.
 *
 * Mono, 11px, right-aligned, --text-faint. It is deliberately the least
 * prominent thing in the pane — it is there to be checked, not read. But it IS
 * there, on every answer, because a product that shows you its retrieval and
 * hides its bill is only half honest.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THE MODEL NAME IS HERE
 *
 * Because it is not a constant. The free pool fails over on 404, 429, and 5xx,
 * so the model that answered a question is frequently not the configured one,
 * and "which model wrote this" stops being something you can look up in an env
 * var the moment failover exists. The name shown is the one recorded on the
 * message row: the model that ACTUALLY served it.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THERE IS NO COST
 *
 * `costCents` is 0 on the free pool and that is the real number, not an
 * estimate — every id is validated `:free` at boot. Rendering "$0.00" would
 * imply a measurement was taken and rounded; "Free" states the fact. Tokens and
 * latency are shown because those ARE measurements, and they are what would
 * turn into money first if this ever moved off the free tier.
 */
export function AnswerMeta({
  metadata,
  className,
}: {
  metadata: AnswerMetadata;
  className?: string;
}) {
  const parts: string[] = [];

  // A null model means no model was called at all — retrieval found nothing
  // above the floor and the answer was the known sentence. Saying so is more
  // useful than an empty slot, and it explains the zero latency next to it.
  parts.push(metadata.model ?? "no model called");

  const tokensIn = metadata.promptTokens;
  const tokensOut = metadata.completionTokens;
  if (tokensIn !== null || tokensOut !== null) {
    parts.push(`${format(tokensIn)} in / ${format(tokensOut)} out`);
  }

  parts.push(metadata.costCents === 0 ? "free" : cents(metadata.costCents));

  if (metadata.latencyMs > 0) parts.push(duration(metadata.latencyMs));

  return (
    <div
      className={cn(
        "num flex flex-wrap items-center justify-end gap-x-2 gap-y-0.5 text-mono-xs text-text-faint",
        className,
      )}
    >
      {parts.map((part, index) => (
        <span key={index} className="whitespace-nowrap">
          {index > 0 ? <span className="mr-2 opacity-50">·</span> : null}
          {part}
        </span>
      ))}

      {/* A stripped marker is a faithfulness violation, and the reader is
          entitled to know one happened to the answer they are looking at —
          it is why a sentence above is uncited. */}
      {metadata.invalidMarkers.length > 0 ? (
        <span
          className="whitespace-nowrap text-warn"
          title="The model cited passages that were not retrieved. Those markers were removed."
        >
          <span className="mr-2 opacity-50">·</span>
          {metadata.invalidMarkers.length} invalid marker
          {metadata.invalidMarkers.length === 1 ? "" : "s"} removed
        </span>
      ) : null}
    </div>
  );
}

function format(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US");
}

/** Integer cents, formatted at the edge. Never a fabricated fraction. */
function cents(value: number): string {
  return `${(value / 100).toFixed(2)} USD`;
}

function duration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
