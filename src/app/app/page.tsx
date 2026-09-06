import type { Metadata } from "next";
import { FileText } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { UploadButton } from "@/components/upload/upload-button";
import {
  UploadDropzone,
  UploadHint,
} from "@/components/upload/upload-dropzone";
import { ConversationPane } from "@/components/workspace/conversation-pane";
import { DocumentReader } from "@/components/workspace/document-reader";
import { Workbench } from "@/components/workspace/workbench";
import { requireUser } from "@/lib/auth-server";
import { listUserDocuments } from "@/lib/documents";
import { isDemoUser } from "@/lib/demo";
import { readWorkspacePrefs } from "@/lib/workspace-prefs.server";

export const metadata: Metadata = { title: "Workspace" };

/**
 * The workspace with nothing open. The frame is identical to a document view —
 * same panes, same widths — so opening a document changes the contents and not
 * the layout.
 *
 * The conversation pane is live here and starts with an EMPTY SCOPE: this is a
 * new conversation with nothing selected yet, and the composer says so. Picking
 * documents in the scope selector is enough to ask a question; the conversation
 * row itself is written by the first question, not by arriving on this page.
 *
 * This is also the primary drop target for a first upload, so the empty state
 * states the accepted types and the size cap up front.
 */
export default async function WorkspacePage() {
  const user = await requireUser();
  const [{ conversationWidth }, documents] = await Promise.all([
    readWorkspacePrefs(),
    listUserDocuments(user.id),
  ]);

  const empty = documents.length === 0;
  const uploadsDisabled = isDemoUser(user.id);

  return (
    <Workbench
      initialConversationWidth={conversationWidth}
      reading={
        // Nothing is open here, but the reader still mounts: a conversation
        // can be started from this screen, and the citation it produces has to
        // be able to open its source without a navigation.
        <DocumentReader
          initialView={null}
          fallback={
            <UploadDropzone>
              <div className="flex min-h-0 flex-1 items-center justify-center bg-room p-6">
                <div className="flex flex-col items-center gap-3">
                  {/* In the demo the empty state must not invite an upload it
                      is going to refuse. The banner above already says why,
                      and the library is never empty there — the seed put four
                      documents in it. */}
                  <EmptyState
                    icon={FileText}
                    title={
                      uploadsDisabled
                        ? "Open a document from the library to read it here."
                        : empty
                          ? "Drop a document here, or upload one, to start asking questions about it."
                          : "Open a document from the library to read it here."
                    }
                    action={uploadsDisabled ? undefined : <UploadButton />}
                  />
                  {uploadsDisabled ? null : <UploadHint />}
                </div>
              </div>
            </UploadDropzone>
          }
        />
      }
      conversation={
        <ConversationPane
          key="new"
          conversation={null}
          initialMessages={[]}
          initialScope={[]}
          documents={documents.map((row) => ({
            id: row.id,
            title: row.title,
            status: row.status,
          }))}
        />
      }
    />
  );
}
