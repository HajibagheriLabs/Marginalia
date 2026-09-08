import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { FileQuestion } from "lucide-react";

/**
 * 404 INSIDE THE WORKSPACE.
 *
 * Separate from the root one because it renders inside the workspace layout:
 * the library rail stays on screen, so a reader who followed a stale link to a
 * deleted document can click straight to another one instead of being thrown
 * out to a marketing page.
 *
 * This is also what `requireDocumentAccess` and `requireConversationAccess`
 * produce for a document belonging to SOMEBODY ELSE. The wording has to be true
 * for both cases and must not distinguish them — "you do not have access to
 * this" would confirm the id exists, which is exactly the probe those helpers
 * 404 identically to prevent.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="flex flex-col items-center gap-1">
        <h1 className="sr-only">Not found</h1>
        <EmptyState
          icon={FileQuestion}
          title="This document or conversation is not available. It may have been deleted."
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/app">Back to the workspace</Link>
            </Button>
          }
        />
      </div>
    </div>
  );
}
