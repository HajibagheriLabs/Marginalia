import { FileText } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { UploadDropzone } from "@/components/upload/upload-dropzone";
import {
  DocumentActions,
  RetryIngestionButton,
} from "@/components/workspace/document-actions";
import { PlaceholderPageContent } from "@/components/workspace/placeholder-page";
import { ReadingSurface } from "@/components/workspace/reading-surface";
import type { Document } from "@/db/schema";
import { DOCUMENT_STATUS_META } from "@/lib/document-status";
import { PLACEHOLDER_PAGE } from "@/lib/placeholder";
import { formatBytes, formatPageCount } from "@/lib/upload";

/**
 * The centre pane: a slim monochrome header, then the table with the sheet on
 * it. The header carries the title, the size or page count, and the one
 * destructive action — the reading pane is for reading.
 *
 * The whole pane is a drop target, which is the behaviour people try first.
 */
export function ReadingPane({ document }: { document: Document }) {
  const meta = DOCUMENT_STATUS_META[document.status];

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

      {document.status === "ready" ? (
        <ReadingSurface>
          <PlaceholderPageContent page={PLACEHOLDER_PAGE} />
        </ReadingSurface>
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
          ) : (
            <EmptyState
              icon={FileText}
              title={`This document is uploaded and ${meta.label.toLowerCase()}. Text extraction, chunking, and indexing arrive in the next step — it becomes readable and searchable then.`}
            />
          )}
        </div>
      )}
    </UploadDropzone>
  );
}
