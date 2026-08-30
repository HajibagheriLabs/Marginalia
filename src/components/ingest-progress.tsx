"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { ProgressBar } from "@/components/progress-bar";
import { StatusDot } from "@/components/status-dot";
import type { DocumentStatus } from "@/db/schema";
import type { DocumentProgress } from "@/lib/ingest/progress";
import {
  describeProgress,
  progressPercent,
} from "@/lib/ingest/progress-format";
import { cn } from "@/lib/utils";
import { getDocumentProgress } from "@/server/actions/documents";

/**
 * What a document is doing right now, while it is being processed.
 *
 * The rule this is built to: say something with SUBSTANCE. "Embedding 240 of
 * 612 passages" tells the reader the document is two-fifths done, that it is
 * moving, and roughly how long is left. A spinner tells them the page has not
 * frozen. Only one of those is worth showing someone who is waiting.
 *
 * The bar appears ONLY during embedding, because that is the only stage with a
 * countable unit of work. Extraction is one indivisible parse of a whole file;
 * a bar there could only move on a timer, which is an animation pretending to
 * be information. During those stages the stage name stands alone, which is the
 * honest readout.
 *
 * Polling, not streaming. The work happens in a different function invocation
 * from the one that rendered this page — there is no open connection to push
 * down, and opening one per watching tab to carry an integer every two seconds
 * would cost more than asking for it does. Polling stops the moment the
 * document reaches a terminal state, so a ready document costs nothing.
 */

const POLL_INTERVAL_MS = 2_000;

export function IngestProgress({
  documentId,
  initial,
  className,
}: {
  documentId: string;
  /** Server-rendered starting point, so the first paint is never empty. */
  initial: {
    status: DocumentStatus;
    pageCount: number | null;
    chunkCount: number | null;
    indexedCount: number;
  };
  className?: string;
}) {
  const router = useRouter();
  const [progress, setProgress] = useState(initial);

  // The status the server last rendered. When polling finds a different one,
  // the rest of the page — the rail's dot, the reading pane's whole branch —
  // is out of date and needs the server to re-render it.
  const renderedStatus = useRef(initial.status);

  useEffect(() => {
    if (initial.status === "ready" || initial.status === "failed") return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      let next: DocumentProgress | null = null;
      try {
        const result = await getDocumentProgress(documentId);
        if (result.ok) next = result.progress;
      } catch {
        // A dropped poll is not worth reporting. The document is still being
        // processed on the server whether or not this tab can see it, and the
        // next tick will pick the answer back up.
      }

      if (cancelled) return;

      if (next) {
        setProgress(next);

        if (next.status !== renderedStatus.current) {
          renderedStatus.current = next.status;
          // Pull the server's version of the page: the reading pane swaps
          // branches at `ready`, and the rail's status dot lives outside this
          // component entirely.
          router.refresh();
        }

        if (next.terminal) return;
      }

      timer = setTimeout(poll, POLL_INTERVAL_MS);
    }

    timer = setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [documentId, initial.status, router]);

  const percent = progressPercent(progress);
  const label = describeProgress(progress);

  return (
    <div className={cn("flex w-full max-w-[420px] flex-col gap-2", className)}>
      <div className="flex items-center justify-between gap-3">
        {/* The dot is the same system-state dot the rail uses, so the two
            readouts are visibly the same fact rather than two designs. */}
        <StatusDot status={progress.status} srLabel={false} />
        {/* aria-live so a screen reader hears the stage change without the
            focus moving. Polite: it is progress, not an alert. */}
        <p aria-live="polite" className="flex-1 text-body-sm text-text">
          {label}
        </p>
        {percent === null ? null : (
          <span className="num text-mono-xs text-text-faint">{percent}%</span>
        )}
      </div>

      {percent === null ? null : (
        <ProgressBar value={percent} label={label} />
      )}
    </div>
  );
}
