import { FileText } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { IngestProgress } from "@/components/ingest-progress";
import { UploadDropzone } from "@/components/upload/upload-dropzone";
import { DocumentViewer } from "@/components/viewer/document-viewer";
import {
  DocumentActions,
  RetryIngestionButton,
} from "@/components/workspace/document-actions";
import type { Document } from "@/db/schema";
import { loadDocumentView } from "@/lib/document-view";
import { formatBytes, formatPageCount } from "@/lib/upload";

/**
 * The centre pane: a slim monochrome header, then the viewer.
 *
 * The header carries the title, the size or page count, and the one
 * destructive action; everything about reading the document itself belongs to
 * the viewer below it. The whole pane is a drop target, which is the behaviour
 * people try first.
 *
 * The view is assembled HERE, on the server, rather than fetched by the
 * viewer: the page rows are a plain indexed read, and doing it during the
 * render that the reader is already waiting for costs nothing and means the
 * first paint is the document rather than a loading state that then becomes
 * the document.
 */
export async function ReadingPane({
  document,
  indexedCount = 0,
}: {
  document: Document;
  /** Passages already embedded, so the first paint already shows a number. */
  indexedCount?: number;
}) {
  const ready = document.status === "ready";
  const view = ready ? await loadDocumentView(document) : null;

  return (
    <UploadDropzone>
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-edge bg-room pr-1.5 pl-4">
        <h1 className="truncate text-body font-medium text-text">
          {document.title}
        </h1>
        <div className="flex shrink-0 items-center gap-2">
          <span className="num text-mono-xs text-text-faint">
            {document.pageCount === null
              ? formatBytes(document.byteSize)
              : formatPageCount(document.mimeType, document.pageCount)}
          </span>
          <DocumentActions documentId={document.id} title={document.title} />
        </div>
      </header>

      {view && view.pageCount > 0 ? (
        <DocumentViewer view={view} />
      ) : (
        // Nothing is lifted here: a document that cannot be read has no sheet.
        // The room stays empty, which is the honest picture of the state.
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-room p-6">
          {document.status === "failed" ? (
            <ErrorState
              className="max-w-[480px]"
              title="This document could not be processed."
              detail={document.errorMessage ?? undefined}
              action={<RetryIngestionButton documentId={document.id} />}
            />
          ) : ready ? (
            // Ready, but no pages were written. Rare, and worth its own
            // sentence: retrying ingestion is the fix, not waiting.
            <ErrorState
              className="max-w-[480px]"
              title="No text was stored for this document."
              detail="It finished processing without producing any pages. Re-running ingestion usually resolves it."
              action={<RetryIngestionButton documentId={document.id} />}
            />
          ) : (
            // Mid-pipeline. The stage and its counts, not a spinner — see
            // IngestProgress for why the bar only appears while embedding.
            <div className="flex w-full max-w-[480px] flex-col items-center gap-4">
              <EmptyState
                icon={FileText}
                title="This document becomes readable and searchable once indexing finishes. You can close this tab — processing continues on the server."
              />
              <IngestProgress
                documentId={document.id}
                initial={{
                  status: document.status,
                  pageCount: document.pageCount,
                  chunkCount: document.chunkCount,
                  indexedCount,
                }}
              />
            </div>
          )}
        </div>
      )}
    </UploadDropzone>
  );
}
