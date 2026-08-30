import type { Metadata } from "next";

import { ConversationPane } from "@/components/workspace/conversation-pane";
import { ReadingPane } from "@/components/workspace/reading-pane";
import { Workbench } from "@/components/workspace/workbench";
import { requireDocumentAccess } from "@/lib/auth-server";
import { readWorkspacePrefs } from "@/lib/workspace-prefs.server";

/**
 * Reading one document.
 *
 * `requireDocumentAccess` is the ownership boundary: it returns the row and
 * proves the session owns it in one call, and it answers 404 identically
 * whether the id is malformed, missing, soft-deleted, or belongs to somebody
 * else. A 403 would turn a document id into an oracle.
 */
export async function generateMetadata({
  params,
}: PageProps<"/app/documents/[documentId]">): Promise<Metadata> {
  const { documentId } = await params;
  const { document } = await requireDocumentAccess(documentId);
  return { title: document.title };
}

export default async function DocumentPage({
  params,
}: PageProps<"/app/documents/[documentId]">) {
  const { documentId } = await params;
  const { document } = await requireDocumentAccess(documentId);

  const { conversationWidth } = await readWorkspacePrefs();
  const ready = document.status === "ready";

  return (
    <Workbench
      initialConversationWidth={conversationWidth}
      reading={<ReadingPane document={document} />}
      conversation={
        <ConversationPane
          documentsInScope={ready ? 1 : 0}
          canAsk={ready}
          disabledReason="This document is not ready to search yet."
        />
      }
    />
  );
}
