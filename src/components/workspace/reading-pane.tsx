import { FileText } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { IngestProgress } from "@/components/ingest-progress";
import { UploadDropzone } from "@/components/upload/upload-dropzone";
import {
  DocumentReader,
  ReadingHeader,
} from "@/components/workspace/document-reader";
import { RetryIngestionButton } from "@/components/workspace/document-actions";
import type { Document } from "@/db/schema";
import { loadDocumentView } from "@/lib/document-view";
import { formatBytes, formatPageCount } from "@/lib/upload";

/**
 * The centre pane.
 *
 * Two shapes, decided on the server:
 *
 *   READY — the header and the viewer, in a client component that can swap to
 *     another document when a citation points at one. See `DocumentReader`.
 *   NOT READY — the header and an honest account of what is happening:
 *     progress while the pipeline runs, an error and a retry when it failed.
 *     Nothing is lifted; a document that cannot be read has no sheet, and the
 *     empty room is the truthful picture of that state.
 *
 * The view is assembled HERE rather than fetched by the viewer: the page rows
 * are a plain indexed read, and doing it during the render the reader is
 * already waiting for costs nothing and means the first paint is the document
 * rather than a loading state that becomes one.
 *
 * The whole pane is a drop target, which is the behaviour people try first.
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

  if (view && view.pageCount > 0) {
    return (
      <UploadDropzone>
        <DocumentReader initialView={view} fallback={null} />
      </UploadDropzone>
    );
  }

  return (
    <UploadDropzone>
      <ReadingHeader
        documentId={document.id}
        title={document.title}
        meta={
          document.pageCount === null
            ? formatBytes(document.byteSize)
            : formatPageCount(document.mimeType, document.pageCount)
        }
      />

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
    </UploadDropzone>
  );
}
