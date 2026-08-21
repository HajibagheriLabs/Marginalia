"use client";

import Link from "next/link";

import { StatusDot } from "@/components/status-dot";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { DocumentStatus } from "@/db/schema";
import { DOCUMENT_STATUS_META } from "@/lib/document-status";
import { cn } from "@/lib/utils";

export interface DocumentListItemProps {
  href: string;
  title: string;
  /** Null until extraction has counted the pages. */
  pageCount: number | null;
  status: DocumentStatus;
  /** The document currently open in the reading pane. */
  active?: boolean;
  /** The 56px icon rail: initial + dot only, with the title in a tooltip. */
  collapsed?: boolean;
  className?: string;
}

/**
 * One row in the library rail.
 *
 * Three pieces of information, in the order the eye needs them: the title, the
 * page count (mono, like every number in this application), and the ingestion
 * state. The row is entirely monochrome apart from the 6px status dot, which is
 * a system state rather than an ink — the rail must never look like it is
 * showing citations.
 *
 * The status word appears in full for every state except `ready`, because
 * "ready" is the state a document is supposed to be in and saying so on every
 * row would be filler. A document that is mid-flight or broken says what it is.
 */
export function DocumentListItem({
  href,
  title,
  pageCount,
  status,
  active = false,
  collapsed = false,
  className,
}: DocumentListItemProps) {
  const meta = DOCUMENT_STATUS_META[status];
  const pages =
    pageCount === null
      ? null
      : `${pageCount} ${pageCount === 1 ? "page" : "pages"}`;

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            href={href}
            aria-current={active ? "page" : undefined}
            aria-label={`${title} — ${meta.label}`}
            data-active={active || undefined}
            className={cn(
              "relative flex size-8 shrink-0 items-center justify-center rounded-control",
              "text-mono-sm font-medium text-text-muted uppercase",
              "num hover:bg-surface-raised hover:text-text",
              "data-[active]:bg-surface-raised data-[active]:text-text",
              className,
            )}
          >
            {title.slice(0, 1)}
            {/* The dot rides the corner of the tile when there is no room for
                a label. */}
            <StatusDot
              status={status}
              srLabel={false}
              className="absolute right-0.5 bottom-0.5"
            />
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right">
          <span className="block text-body-sm text-text">{title}</span>
          <span className="num mt-0.5 block text-mono-xs text-text-faint">
            {[pages, status === "ready" ? null : meta.label]
              .filter(Boolean)
              .join(" · ") || meta.label}
          </span>
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      data-active={active || undefined}
      className={cn(
        "flex flex-col gap-0.5 rounded-control px-2 py-1.5",
        "hover:bg-surface-raised data-[active]:bg-surface-raised",
        className,
      )}
    >
      <span className="flex items-start gap-2">
        <StatusDot
          status={status}
          srLabel={false}
          className="mt-[7px] shrink-0"
        />
        <span
          className={cn(
            "line-clamp-2 text-body-sm",
            active ? "font-medium text-text" : "text-text-muted",
          )}
        >
          {title}
        </span>
      </span>

      {/* Mono is reserved for numbers and identifiers, so the page count is
          mono and the status word beside it is not. */}
      {pages || status !== "ready" ? (
        <span className="flex items-center gap-1.5 pl-3.5 text-[11px] leading-[1.45] text-text-faint">
          {pages ? <span className="num">{pages}</span> : null}
          {pages && status !== "ready" ? <span aria-hidden>·</span> : null}
          {status === "ready" ? null : <span>{meta.label}</span>}
        </span>
      ) : null}
    </Link>
  );
}
