"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { useBridgeState } from "@/components/viewer/citation-bridge";
import { DocumentViewer } from "@/components/viewer/document-viewer";
import { PageSkeleton } from "@/components/viewer/page-skeleton";
import { PaperSheet } from "@/components/paper-sheet";
import { DocumentActions } from "@/components/workspace/document-actions";
import type { DocumentView } from "@/lib/viewer/types";
import { formatBytes, formatPageCount } from "@/lib/upload";
import { getDocumentView } from "@/server/actions/viewer";

/**
 * THE READING PANE FOR A DOCUMENT THAT IS READY.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * IT SWAPS DOCUMENTS WITHOUT A NAVIGATION
 *
 * A conversation searches several documents, so a citation frequently points
 * at one the reading pane is not showing. Routing to it would be the obvious
 * move and the wrong one: it would tear down the conversation pane to change
 * what is on the other side of the separator, discarding an answer that may
 * still be streaming and the scroll position of the thread. So the pane fetches
 * the other document's view and swaps it in place.
 *
 * Views are cached by id for the life of the pane. Reading a conversation
 * across three documents means three fetches, ever — clicking back and forth
 * between citations after that is instant, which is exactly the interaction
 * this whole feature exists for.
 *
 * The document that was server-rendered is seeded into the cache, so the first
 * paint is the document itself rather than a skeleton that becomes one.
 *
 * `initialView` is NULL on the workspace root and on a conversation whose
 * documents are all still processing — there is nothing open to read. The
 * reader still mounts, showing `fallback`, because a citation activated from
 * one of those screens has to land somewhere. Without it, the one case where a
 * reader most needs to be shown the source is the case where clicking does
 * nothing at all.
 */
export function DocumentReader({
  initialView,
  fallback,
}: {
  initialView: DocumentView | null;
  /** Shown when no document is open. */
  fallback: React.ReactNode;
}) {
  const { activeDocumentId } = useBridgeState();
  const documentId = activeDocumentId ?? initialView?.documentId ?? null;

  const [views, setViews] = useState<Record<string, DocumentView>>(() =>
    initialView ? { [initialView.documentId]: initialView } : {},
  );

  const view = documentId ? views[documentId] : null;

  useEffect(() => {
    if (!documentId || views[documentId]) return;

    let cancelled = false;
    void getDocumentView(documentId).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        // The document was deleted, or is being re-ingested. Saying so beats
        // a pane stuck on a skeleton with no explanation.
        toast.error(result.error);
        return;
      }
      setViews((previous) => ({
        ...previous,
        [result.view.documentId]: result.view,
      }));
    });

    return () => {
      cancelled = true;
    };
  }, [documentId, views]);

  // Nothing open, and nothing asked for. The page's own empty state.
  if (!documentId) {
    /*
     * THE PAGE'S ONE h1, WHEN THERE IS NO DOCUMENT TO NAME IT.
     *
     * With a document open, `ReadingHeader` below carries the h1 and it is the
     * document's title — the most useful heading the page could have. With
     * nothing open there was no h1 at all, so `/app` and a conversation whose
     * documents are still ingesting had a heading outline that started at h2.
     *
     * Visually hidden rather than drawn: the empty state already says what to
     * do in a full sentence, and a heading above it would be the interface
     * repeating itself. Exactly one of these two branches renders at a time, so
     * the page never has two.
     */
    return (
      <>
        <h1 className="sr-only">Workspace</h1>
        {fallback}
      </>
    );
  }

  // A view being fetched. A paper-coloured sheet at roughly the size of the
  // page that is coming, rather than a spinner on an empty table — same rule
  // the viewer's own loading state follows.
  if (!view) {
    return (
      <>
        <ReadingHeader documentId={documentId} title="Opening…" meta="" />
        <div className="min-h-0 flex-1 overflow-auto bg-room px-4 py-6 sm:px-8 sm:py-10">
          <PaperSheet className="max-w-[720px]" contentClassName="p-0">
            <PageSkeleton />
          </PaperSheet>
        </div>
      </>
    );
  }

  return (
    <>
      <ReadingHeader
        documentId={view.documentId}
        title={view.title}
        meta={
          view.pageCount > 0
            ? formatPageCount(view.mimeType, view.pageCount)
            : formatBytes(view.byteSize)
        }
      />
      {/* Keyed by document: switching sources resets zoom, search, and the
          virtualiser's height table, none of which mean anything about the
          document that just arrived. */}
      <DocumentViewer key={view.documentId} view={view} />
    </>
  );
}

/**
 * The pane's header: title, size or page count, and the one destructive
 * action. Shared with the not-ready states in `ReadingPane` so a document that
 * is still processing and one that is open look like the same pane.
 */
export function ReadingHeader({
  documentId,
  title,
  meta,
}: {
  documentId: string;
  title: string;
  meta: string;
}) {
  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-edge bg-room pr-1.5 pl-4">
      <h1 className="truncate text-body font-medium text-text">{title}</h1>
      <div className="flex shrink-0 items-center gap-2">
        <span className="num text-mono-xs text-text-faint">{meta}</span>
        <DocumentActions documentId={documentId} title={title} />
      </div>
    </header>
  );
}
