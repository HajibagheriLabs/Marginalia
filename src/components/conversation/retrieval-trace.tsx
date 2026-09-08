"use client";

import { useId, useState } from "react";
import { ChevronRight } from "lucide-react";

import type { UITraceRow } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

/**
 * THE SECOND SIGNATURE — the retrieval trace.
 *
 * A collapsed row under every answer that opens into the whole ranking: which
 * passages each channel found, where each ranked them, what fusion made of
 * that, what the reranker thought, and which ones actually reached the model.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THIS IS A FEATURE, NOT A DEBUG PANEL
 *
 * Which is why it is styled like one thing the product does rather than like
 * something left switched on. It is mono, tabular, aligned, and it is complete:
 * the rows that LOST are the interesting ones. An answer disappoints precisely
 * when the passage that would have answered it was found and ranked fourth, and
 * a trace that only listed the winners would hide the single fact that explains
 * the failure.
 *
 * Collapsed by default, because most answers do not need explaining and a table
 * open under every one of them would bury the conversation.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * NULL IS NOT ZERO
 *
 * A missing rank renders as an em dash, never as 0 or as a blank cell. "The
 * lexical channel ranked this 40th" and "the lexical channel never saw this"
 * are different facts about a passage, and the second one is often the answer
 * to why something ranked where it did.
 */
export function RetrievalTrace({
  rows,
  /**
   * Start expanded.
   *
   * Off in the conversation, where most answers do not need explaining and a
   * table open under every one of them would bury the thread. On where the
   * table IS the subject rather than an appendix to something else — the
   * landing page renders this component with static rows to show what the
   * ranking looks like, and a collapsed row there would show nothing at all.
   */
  defaultOpen = false,
}: {
  rows: UITraceRow[];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();

  const used = rows.filter((row) => row.used).length;
  const reranked = rows.some((row) => row.rerankScore !== null);

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={id}
        className="group/trace -mx-1 flex w-fit items-center gap-1.5 rounded-control px-1 py-0.5 text-left text-mono-xs text-text-faint hover:text-text-muted"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3 shrink-0",
            // The one place a rotation is allowed: it is a state, not an
            // animation, so it is instant like every other hover in the system.
            open && "rotate-90",
          )}
        />
        <span className="num">
          {open ? "Hide" : "Show"} retrieval
          {rows.length > 0 ? ` · ${used} of ${rows.length} used` : ""}
        </span>
      </button>

      {open ? (
        <div id={id} className="flex flex-col gap-1.5">
          {rows.length === 0 ? (
            // Not an error, and worth stating: an empty candidate list is what
            // "nothing in these documents covers that" looks like from below.
            <p className="text-body-sm text-text-muted">
              Neither channel returned a passage for this question.
            </p>
          ) : (
            <>
              {/*
                A SCROLL REGION NEEDS TO BE REACHABLE BY KEYBOARD.

                The table is wider than the conversation pane on every screen
                and much wider on a phone, so it scrolls sideways — and a
                scrollable box that cannot take focus is a box a keyboard user
                cannot scroll. `tabIndex={0}` puts it in the tab order and the
                arrow keys then work; `role="region"` plus a name is what stops
                it being an unlabelled stop on the way to the next answer.
              */}
              <div
                role="region"
                aria-label="Retrieval trace, scrollable"
                tabIndex={0}
                className="focus-ring overflow-x-auto rounded-panel border border-edge bg-surface"
              >
                <table className="w-full border-collapse text-mono-xs">
                  <thead>
                    <tr className="border-b border-edge">
                      <Th className="min-w-[220px] text-left">Passage</Th>
                      <Th className="text-right">Page</Th>
                      <Th className="text-right">Dense</Th>
                      <Th className="text-right">Lexical</Th>
                      <Th className="text-right">RRF</Th>
                      {reranked ? <Th className="text-right">Rerank</Th> : null}
                      <Th className="text-right">Used</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => (
                      <tr
                        key={row.chunkId ?? `row-${index}`}
                        className={cn(
                          "border-b border-edge last:border-b-0 align-top",
                          // The rows that reached the model are the ones the
                          // answer rests on; the rest are dimmed rather than
                          // hidden.
                          row.used ? "text-text" : "text-text-faint",
                        )}
                      >
                        <td className="px-2.5 py-1.5">
                          <span className="block font-sans text-body-sm leading-snug">
                            {row.snippet || "This passage has been re-ingested."}
                          </span>
                          {row.documentTitle ? (
                            <span className="mt-0.5 block truncate text-mono-xs text-text-faint">
                              {row.documentTitle}
                            </span>
                          ) : null}
                        </td>
                        <Td>{pageRange(row)}</Td>
                        <Td>{rank(row.denseRank, row.denseScore)}</Td>
                        <Td>{rank(row.lexicalRank, row.lexicalScore)}</Td>
                        <Td>{score(row.rrfScore, 4)}</Td>
                        {reranked ? <Td>{score(row.rerankScore, 1)}</Td> : null}
                        <Td>{row.used ? "yes" : "no"}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* The scales are not comparable, and saying so once here is
                  cheaper than a reader inferring it wrongly from the numbers. */}
              <p className="text-mono-xs leading-relaxed text-text-faint">
                Dense is cosine similarity, lexical is ts_rank_cd, and the two
                are not on the same scale. RRF fuses the RANKS, not the scores.
                An em dash means that channel never returned the passage.
              </p>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Th({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <th
      scope="col"
      className={cn(
        "px-2.5 py-1.5 font-medium whitespace-nowrap text-text-faint",
        className,
      )}
    >
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return (
    <td className="num px-2.5 py-1.5 text-right whitespace-nowrap tabular-nums">
      {children}
    </td>
  );
}

function pageRange(row: UITraceRow): string {
  if (row.pageFrom === null) return "—";
  return row.pageTo !== null && row.pageTo !== row.pageFrom
    ? `${row.pageFrom}–${row.pageTo}`
    : String(row.pageFrom);
}

/**
 * A channel's contribution: its 1-based rank, with the raw score beneath it.
 *
 * Rank first because rank is what fusion actually used; the score is there to
 * show how close the call was.
 */
function rank(position: number | null, value: number | null): React.ReactNode {
  if (position === null) return "—";
  return (
    <>
      <span className="block">#{position}</span>
      <span className="block text-text-faint">{score(value, 3)}</span>
    </>
  );
}

function score(value: number | null, digits: number): string {
  if (value === null) return "—";
  return value.toFixed(digits);
}
