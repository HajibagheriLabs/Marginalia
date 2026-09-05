"use client";

import { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MIN_QUERY_LENGTH } from "@/lib/viewer/search";

/**
 * IN-DOCUMENT SEARCH.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS TAKES Cmd+F AWAY FROM THE BROWSER
 *
 * Overriding a browser shortcut is usually rude, and this is the case where it
 * is not. The viewer mounts only the pages near the viewport, so the browser's
 * own find has nothing to search on pages 40 through 300 — it would report
 * "1 of 2" on a document with two hundred matches and quietly mean it. That is
 * worse than a hijacked shortcut: it is a correct-looking wrong answer.
 *
 * This one runs on the server against the extracted text, so it sees the whole
 * document. Escape closes it and gives the shortcut back.
 *
 * The status line always says something. "No matches" is a result; leaving the
 * counter blank is the interface declining to answer.
 */
export function ViewerSearchBar({
  query,
  onQueryChange,
  matchCount,
  currentIndex,
  truncated,
  pending,
  error,
  onNext,
  onPrevious,
  onClose,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  matchCount: number;
  /** 0-based position in the match list, or null when there are none. */
  currentIndex: number | null;
  /** True when the match cap was hit and the count is a floor, not a total. */
  truncated: boolean;
  pending: boolean;
  error: string | null;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Opening the bar is the whole gesture; making the reader click into it
  // afterwards would waste the shortcut they just pressed.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const tooShort = query.trim().length > 0 && query.trim().length < MIN_QUERY_LENGTH;

  return (
    <div
      role="search"
      className="flex h-10 shrink-0 items-center gap-2 border-b border-edge bg-surface px-2"
    >
      <Input
        ref={inputRef}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="Find in document"
        aria-label="Find in document"
        className="h-7 max-w-[220px] flex-1"
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (event.shiftKey) onPrevious();
            else onNext();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      />

      <p
        aria-live="polite"
        className="num min-w-[86px] text-mono-xs whitespace-nowrap text-text-faint tabular-nums"
      >
        {status({ query, tooShort, pending, error, matchCount, currentIndex, truncated })}
      </p>

      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onPrevious}
        disabled={matchCount === 0}
        aria-label="Previous match"
      >
        <ChevronUp aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onNext}
        disabled={matchCount === 0}
        aria-label="Next match"
      >
        <ChevronDown aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onClose}
        aria-label="Close search"
      >
        <X aria-hidden />
      </Button>
    </div>
  );
}

function status(input: {
  query: string;
  tooShort: boolean;
  pending: boolean;
  error: string | null;
  matchCount: number;
  currentIndex: number | null;
  truncated: boolean;
}): string {
  if (input.error) return input.error;
  if (input.query.trim().length === 0) return "";
  if (input.tooShort) return `${MIN_QUERY_LENGTH} characters minimum`;
  if (input.pending) return "Searching…";
  if (input.matchCount === 0) return "No matches";

  const position = (input.currentIndex ?? 0) + 1;
  // "of 500+" rather than "of 500": the cap was hit, so the total is a floor.
  // Reporting the cap as a total would be a number the search knows is wrong.
  return `${position} of ${input.matchCount}${input.truncated ? "+" : ""}`;
}
