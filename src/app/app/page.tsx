import type { Metadata } from "next";
import { FileText } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { ConversationPane } from "@/components/workspace/conversation-pane";
import { PlaceholderAction } from "@/components/workspace/placeholder-action";
import { Workbench } from "@/components/workspace/workbench";
import { readWorkspacePrefs } from "@/lib/workspace-prefs.server";

export const metadata: Metadata = { title: "Workspace" };

/**
 * The workspace with nothing open. The frame is identical to a document view —
 * same panes, same widths — so opening a document changes the contents and not
 * the layout.
 */
export default async function WorkspacePage() {
  const { conversationWidth } = await readWorkspacePrefs();

  return (
    <Workbench
      initialConversationWidth={conversationWidth}
      reading={
        <div className="flex min-h-0 flex-1 items-center justify-center bg-room p-6">
          <EmptyState
            icon={FileText}
            title="Open a document from the library to read it here."
            action={
              <PlaceholderAction
                variant="outline"
                size="sm"
                note="Uploading arrives with the ingestion pipeline."
              >
                Upload a document
              </PlaceholderAction>
            }
          />
        </div>
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
