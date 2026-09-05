"use client";

import { useId, useState } from "react";
import { Check } from "lucide-react";

import { DOCUMENT_STATUS_META } from "@/lib/document-status";
import type { DocumentStatus } from "@/db/schema";
import { inkForIndex, inkVar, type InkName } from "@/lib/ink";
import { cn } from "@/lib/utils";

/**
 * WHICH DOCUMENTS THIS CONVERSATION SEARCHES.
 *
 * Collapsed it is one line: the ink swatches in scope order and a count. That
 * line is the legend for every chip below it — it is how a reader learns that
 * yellow is the contract — so it is always visible even when the picker is not.
 *
 * Expanded it is a checkbox per document, each carrying the ink it would be
 * assigned. The swatch is shown for UNSELECTED documents too, greyed: selecting
 * one appends it to the scope, so the colour it will take is knowable before
 * the click. Colours are POSITIONAL, so the preview for an unselected document
 * is the colour it would take at the end of the list.
 *
 * A document that is not `ready` cannot be searched. It is listed and it is
 * disabled, with its stage named — hiding it would leave the reader wondering
 * where a document they just uploaded went.
 */
export function ScopeSelector({
  documents,
  selectedIds,
  inks,
  onChange,
  disabled = false,
}: {
  /** Every document the user owns, newest first — the rail's order. */
  documents: { id: string; title: string; status: DocumentStatus }[];
  /** In scope order. That order assigns the inks. */
  selectedIds: string[];
  /** documentId -> ink, for the documents currently in scope. */
  inks: Map<string, InkName>;
  onChange: (documentIds: string[]) => void;
  /** True while an answer is streaming: scope must not move mid-question. */
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();

  const selected = new Set(selectedIds);
  const inScope = selectedIds
    .map((documentId) => documents.find((row) => row.id === documentId))
    .filter((row) => row !== undefined);

  function toggle(documentId: string) {
    // Appended on select, filtered on deselect — never rebuilt from the render
    // order. Rebuilding would re-colour documents whose membership never
    // changed, because ink is positional in this array.
    onChange(
      selected.has(documentId)
        ? selectedIds.filter((value) => value !== documentId)
        : [...selectedIds, documentId],
    );
  }

  return (
    <div className="flex flex-col border-b border-edge">
      <div className="flex h-9 shrink-0 items-center gap-2 px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="flex shrink-0 items-center gap-1">
            {inScope.slice(0, 4).map((document) => (
              <Swatch
                key={document.id}
                ink={inks.get(document.id)}
                title={document.title}
              />
            ))}
          </span>
          <span className="truncate text-mono-xs text-text-faint">
            {label(inScope.length, inScope[0]?.title)}
          </span>
        </div>

        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={id}
          disabled={disabled}
          className="shrink-0 rounded-control px-1.5 py-0.5 text-mono-xs text-text-muted hover:text-text disabled:opacity-50"
        >
          {open ? "Done" : "Change"}
        </button>
      </div>

      {open ? (
        <ul
          id={id}
          className="max-h-[240px] overflow-y-auto border-t border-edge px-2 py-1.5"
        >
          {documents.length === 0 ? (
            <li className="px-2 py-2 text-body-sm text-text-muted">
              No documents yet. Upload one to ask about it.
            </li>
          ) : (
            documents.map((document, index) => {
              const isSelected = selected.has(document.id);
              const meta = DOCUMENT_STATUS_META[document.status];
              const searchable = document.status === "ready";

              return (
                <li key={document.id}>
                  <label
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 rounded-control px-2 py-1.5",
                      "hover:bg-surface-raised",
                      !searchable && "cursor-not-allowed opacity-60",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      disabled={!searchable || disabled}
                      onChange={() => toggle(document.id)}
                      className="peer sr-only"
                    />
                    {/* The box is drawn rather than native so it can carry the
                        system's 4px radius and its own focus ring. */}
                    <span
                      aria-hidden
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-control border border-edge-strong",
                        "peer-checked:border-text peer-checked:bg-text",
                        "peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-text",
                      )}
                    >
                      {isSelected ? (
                        <Check aria-hidden className="size-3 text-room" />
                      ) : null}
                    </span>

                    <Swatch
                      ink={
                        inks.get(document.id) ??
                        // Not in scope yet: preview the colour it would take,
                        // which is the next position at the end of the list.
                        undefined
                      }
                      title={document.title}
                      muted={!isSelected}
                      fallbackIndex={selectedIds.length + index}
                    />

                    <span className="min-w-0 flex-1 truncate text-body-sm text-text">
                      {document.title}
                    </span>

                    {searchable ? null : (
                      <span className="num shrink-0 text-mono-xs text-text-faint">
                        {meta.label}
                      </span>
                    )}
                  </label>
                </li>
              );
            })
          )}
        </ul>
      ) : null}
    </div>
  );
}

/** The 8px ink dot that ties a document to its citation chips. */
function Swatch({
  ink,
  title,
  muted = false,
  fallbackIndex,
}: {
  ink: InkName | undefined;
  title: string;
  muted?: boolean;
  /** Position used to preview an ink for a document not yet in scope. */
  fallbackIndex?: number;
}) {
  const resolved =
    ink ?? (fallbackIndex === undefined ? undefined : inkForIndex(fallbackIndex));

  if (!resolved) return null;

  return (
    <span
      aria-hidden
      title={title}
      className={cn("size-2 shrink-0 rounded-chip", muted && "opacity-30")}
      style={{ background: inkVar(resolved) }}
    />
  );
}

function label(count: number, firstTitle: string | undefined): string {
  if (count === 0) return "No documents selected";
  if (count === 1) return firstTitle ?? "1 document";
  return `${count} documents`;
}
