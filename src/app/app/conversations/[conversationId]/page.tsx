import type { Metadata } from "next";
import { FileText } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { ConversationPane } from "@/components/workspace/conversation-pane";
import { ReadingPane } from "@/components/workspace/reading-pane";
import { Workbench } from "@/components/workspace/workbench";
import {
  requireConversationAccess,
  requireDocumentAccess,
} from "@/lib/auth-server";
import {
  loadConversationThread,
  loadScopeDocuments,
} from "@/lib/conversations";
import { listUserDocuments } from "@/lib/documents";
import { readWorkspacePrefs } from "@/lib/workspace-prefs.server";

/**
 * One conversation, open.
 *
 * The reading pane shows the FIRST document in the conversation's scope — the
 * one that owns the first ink. That keeps the two panes agreeing about what
 * "this document" means, and clicking a citation (next step) only ever has to
 * switch documents, never decide which one was meant.
 */
export async function generateMetadata({
  params,
}: PageProps<"/app/conversations/[conversationId]">): Promise<Metadata> {
  const { conversationId } = await params;
  const { conversation } = await requireConversationAccess(conversationId);
  return { title: conversation.title ?? "Conversation" };
}

export default async function ConversationPage({
  params,
}: PageProps<"/app/conversations/[conversationId]">) {
  const { conversationId } = await params;
  const { user, conversation } = await requireConversationAccess(conversationId);

  const [{ conversationWidth }, messages, scope, documents] = await Promise.all([
    readWorkspacePrefs(),
    loadConversationThread(conversation.id),
    // IN SCOPE ORDER. That order is what assigns the highlighter inks, so it
    // has to survive the trip from the database to the pane intact.
    loadScopeDocuments(user.id, conversation.documentIds),
    listUserDocuments(user.id),
  ]);

  // The first READY document: an unfinished one has no page to show.
  const openId = scope.find((row) => row.ready)?.id ?? null;
  const open = openId ? (await requireDocumentAccess(openId)).document : null;

  return (
    <Workbench
      initialConversationWidth={conversationWidth}
      reading={
        open ? (
          <ReadingPane document={open} />
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center bg-room p-6">
            <EmptyState
              icon={FileText}
              title={
                scope.length === 0
                  ? "This conversation has no documents selected. Add one above the composer to give it something to search."
                  : "The documents in this conversation are not ready to read yet."
              }
            />
          </div>
        )
      }
      conversation={
        // Keyed by conversation so navigating between threads mounts a fresh
        // chat rather than reusing one thread's client state under another's
        // messages.
        <ConversationPane
          key={conversation.id}
          conversation={{ id: conversation.id, title: conversation.title }}
          initialMessages={messages}
          initialScope={scope}
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
