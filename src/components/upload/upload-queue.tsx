"use client";

import { Check, RotateCcw, X } from "lucide-react";

import { ProgressBar } from "@/components/progress-bar";
import { Button } from "@/components/ui/button";
import {
  useUploads,
  type UploadItem,
} from "@/components/upload/upload-provider";
import { formatBytes } from "@/lib/upload";

/**
 * The upload queue panel.
 *
 * Floats above the workspace rather than living in the rail, for two reasons:
 * the rail collapses to 56px and becomes a drawer below 1024px, and progress
 * you cannot see is progress you will assume has stalled. It sits clear of the
 * mobile tab bar.
 *
 * `--shadow-overlay` is correct here — this is an overlay, and it is the second
 * and last shadow in the system.
 */
export function UploadQueue() {
  const { items, clearFinished } = useUploads();

  if (items.length === 0) return null;

  const active = items.filter(
    (item) =>
      item.status === "queued" ||
      item.status === "uploading" ||
      item.status === "recording",
  ).length;

  return (
    <div
      // Announced politely: an upload finishing should not interrupt whatever
      // the user is reading.
      role="status"
      aria-live="polite"
      aria-label="Uploads"
      className="fixed right-4 bottom-20 z-40 w-[min(340px,calc(100vw-32px))] rounded-panel border border-edge bg-surface shadow-overlay lg:bottom-4"
    >
      <div className="flex h-10 items-center justify-between gap-2 border-b border-edge pr-1.5 pl-3">
        <p className="text-body-sm font-medium text-text">
          {active > 0 ? (
            <>
              Uploading <span className="num">{active}</span>
            </>
          ) : (
            "Uploads"
          )}
        </p>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={clearFinished}
          aria-label="Clear finished uploads"
        >
          <X aria-hidden />
        </Button>
      </div>

      <ul className="max-h-[280px] overflow-y-auto p-1.5">
        {items.map((item) => (
          <li key={item.id}>
            <QueueRow item={item} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Sentence per state. Plain, present tense, no filler. */
function statusLabel(item: UploadItem): string {
  switch (item.status) {
    case "queued":
      return "Waiting";
    case "uploading":
      return `${Math.round(item.progress)}%`;
    case "recording":
      return "Finishing";
    case "done":
      return "Added";
    case "canceled":
      return "Canceled";
    case "error":
      return "Failed";
  }
}

function QueueRow({ item }: { item: UploadItem }) {
  const { cancel, retry, dismiss } = useUploads();
  const inFlight =
    item.status === "queued" ||
    item.status === "uploading" ||
    item.status === "recording";

  return (
    <div className="flex flex-col gap-1.5 rounded-control px-2 py-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-body-sm text-text" title={item.name}>
            {item.name}
          </p>
          <p className="flex items-center gap-1.5 text-[11px] leading-4 text-text-faint">
            {/* Sizes and percentages are numbers, so they are mono. */}
            <span className="num">{formatBytes(item.size)}</span>
            <span aria-hidden>·</span>
            <span className={item.status === "uploading" ? "num" : undefined}>
              {statusLabel(item)}
            </span>
          </p>
        </div>

        {item.status === "done" ? (
          <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-ok" />
        ) : inFlight ? (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => cancel(item.id)}
            aria-label={`Cancel upload of ${item.name}`}
          >
            <X aria-hidden />
          </Button>
        ) : (
          <div className="flex shrink-0 items-center gap-0.5">
            {item.retryable ? (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => retry(item.id)}
                aria-label={`Retry upload of ${item.name}`}
              >
                <RotateCcw aria-hidden />
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => dismiss(item.id)}
              aria-label={`Dismiss ${item.name}`}
            >
              <X aria-hidden />
            </Button>
          </div>
        )}
      </div>

      {item.status === "uploading" || item.status === "recording" ? (
        <ProgressBar
          value={item.status === "recording" ? 100 : item.progress}
          label={`Uploading ${item.name}`}
        />
      ) : null}

      {/* The error is the whole point of the row once it has failed, so it is
          shown in full rather than truncated. */}
      {item.error ? (
        <p className="text-[11px] leading-4 text-danger">{item.error}</p>
      ) : null}
    </div>
  );
}
