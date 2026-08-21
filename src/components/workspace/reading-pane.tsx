import { FileText } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { PlaceholderAction } from "@/components/workspace/placeholder-action";
import { PlaceholderPageContent } from "@/components/workspace/placeholder-page";
import { ReadingSurface } from "@/components/workspace/reading-surface";
import { DOCUMENT_STATUS_META } from "@/lib/document-status";
import { PLACEHOLDER_PAGE, type PlaceholderDocument } from "@/lib/placeholder";

/**
 * The centre pane: a slim monochrome header, then the table with the sheet on
 * it. The header carries the title and the page count and nothing else — the
 * reading pane is for reading.
 */
export function ReadingPane({ document }: { document: PlaceholderDocument }) {
  const meta = DOCUMENT_STATUS_META[document.status];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-edge bg-room px-4">
        <h1 className="truncate text-body font-medium text-text">
          {document.title}
        </h1>
        {document.pageCount === null ? null : (
          <span className="num shrink-0 text-mono-xs text-text-faint">
            {document.pageCount} pages
          </span>
        )}
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
              detail={document.errorMessage}
              action={
                <PlaceholderAction
                  variant="outline"
                  size="sm"
                  note="Retry arrives with the ingestion pipeline."
                >
                  Retry
                </PlaceholderAction>
              }
            />
          ) : (
            <EmptyState
              icon={FileText}
              title={`This document is still being prepared — ${meta.label.toLowerCase()}. It becomes readable and searchable once it is ready.`}
            />
          )}
        </div>
      )}
    </div>
  );
}
