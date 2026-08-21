import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ConversationPane } from "@/components/workspace/conversation-pane";
import { ReadingPane } from "@/components/workspace/reading-pane";
import { Workbench } from "@/components/workspace/workbench";
import { findPlaceholderDocument } from "@/lib/placeholder";
import { readWorkspacePrefs } from "@/lib/workspace-prefs.server";

/**
 * Reading one document.
 *
 * The document is looked up in the placeholder list for now. When ingestion
 * lands this becomes `requireDocumentAccess(documentId)` from
 * src/lib/auth-server.ts — which returns the row and proves ownership in one
 * call, and 404s identically whether the document is missing or belongs to
 * someone else. The `notFound()` below is already the shape of that answer.
 */
export async function generateMetadata({
  params,
}: PageProps<"/app/documents/[documentId]">): Promise<Metadata> {
  const { documentId } = await params;
  const document = findPlaceholderDocument(documentId);
  return { title: document?.title ?? "Document" };
}

export default async function DocumentPage({
  params,
}: PageProps<"/app/documents/[documentId]">) {
  const { documentId } = await params;
  const document = findPlaceholderDocument(documentId);
  if (!document) notFound();

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
