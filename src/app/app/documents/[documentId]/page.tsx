import type { Metadata } from "next";

import { ConversationPane } from "@/components/workspace/conversation-pane";
import { ReadingPane } from "@/components/workspace/reading-pane";
import { Workbench } from "@/components/workspace/workbench";
import { requireDocumentAccess } from "@/lib/auth-server";
import { listUserDocuments } from "@/lib/documents";
import { readDocumentProgress } from "@/lib/ingest/progress";
import { readWorkspacePrefs } from "@/lib/workspace-prefs.server";

/**
 * Reading one document.
 *
 * `requireDocumentAccess` is the ownership boundary: it returns the row and
 * proves the session owns it in one call, and it answers 404 identically
 * whether the id is malformed, missing, soft-deleted, or belongs to somebody
 * else. A 403 would turn a document id into an oracle.
 *
 * The conversation pane here is a NEW conversation, pre-scoped to this
 * document. Opening a document is the most common way a question starts, and
 * making the reader select the thing they are already looking at would be the
 * interface asking a question it can answer itself. Nothing is written until
 * the first question — see `ConversationPane`.
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
  const { user, document } = await requireDocumentAccess(documentId);

  const [{ conversationWidth }, documents] = await Promise.all([
    readWorkspacePrefs(),
    listUserDocuments(user.id),
  ]);

  const ready = document.status === "ready";

  // Server-rendered so the progress readout has a real number on first paint
  // rather than flashing "0 of 612" until the first poll lands.
  const progress = ready
    ? null
    : await readDocumentProgress(document.id, user.id);

  return (
    <Workbench
      initialConversationWidth={conversationWidth}
      reading={
        <ReadingPane
          document={document}
          indexedCount={progress?.indexedCount ?? 0}
        />
      }
      conversation={
        // Keyed by document: opening a different one starts a different new
        // conversation rather than carrying the previous scope across.
        <ConversationPane
          key={`new-${document.id}`}
          conversation={null}
          initialMessages={[]}
          initialScope={[
            {
              id: document.id,
              title: document.title,
              status: document.status,
              ready,
            },
          ]}
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
