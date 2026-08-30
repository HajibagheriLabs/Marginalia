import type { Metadata } from "next";
import { FileText } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { UploadButton } from "@/components/upload/upload-button";
import {
  UploadDropzone,
  UploadHint,
} from "@/components/upload/upload-dropzone";
import { ConversationPane } from "@/components/workspace/conversation-pane";
import { Workbench } from "@/components/workspace/workbench";
import { requireUser } from "@/lib/auth-server";
import { countUserDocuments } from "@/lib/documents";
import { readWorkspacePrefs } from "@/lib/workspace-prefs.server";

export const metadata: Metadata = { title: "Workspace" };

/**
 * The workspace with nothing open. The frame is identical to a document view —
 * same panes, same widths — so opening a document changes the contents and not
 * the layout.
 *
 * This is also the primary drop target for a first upload, so the empty state
 * states the accepted types and the size cap up front.
 */
export default async function WorkspacePage() {
  const user = await requireUser();
  const [{ conversationWidth }, documentCount] = await Promise.all([
    readWorkspacePrefs(),
    countUserDocuments(user.id),
  ]);

  const empty = documentCount === 0;

  return (
    <Workbench
      initialConversationWidth={conversationWidth}
      reading={
        <UploadDropzone>
          <div className="flex min-h-0 flex-1 items-center justify-center bg-room p-6">
            <div className="flex flex-col items-center gap-3">
              <EmptyState
                icon={FileText}
                title={
                  empty
                    ? "Drop a document here, or upload one, to start asking questions about it."
                    : "Open a document from the library to read it here."
                }
                action={<UploadButton />}
              />
              <UploadHint />
            </div>
          </div>
        </UploadDropzone>
      }
      conversation={
        <ConversationPane
          documentsInScope={0}
          canAsk={false}
          disabledReason="Open a document before asking a question."
        />
      }
    />
  );
}
