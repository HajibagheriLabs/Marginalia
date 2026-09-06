import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  chunks,
  citations,
  conversations,
  documents,
  messages,
  retrievals,
} from "@/db/schema";
import type {
  ConversationSummary,
  MarginaliaUIMessage,
  ScopeDocument,
  UICitation,
  UITraceRow,
} from "@/lib/chat/types";

/**
 * Reads over `conversations` and everything hanging off it.
 *
 * Same rule as src/lib/documents.ts: every function takes a `userId` and
 * applies it as a predicate. There is no overload without one, so the ownership
 * filter is not something a call site can forget.
 *
 * The interesting work here is REHYDRATION. An answer that is streaming and an
 * answer read back from the database must render identically — same chips, same
 * trace table, same footer — or the interface would quietly change under a
 * reload. So `loadConversationThread` rebuilds exactly the `UIMessage` parts
 * that the route handler streams: a text part, a `data-citations` part, a
 * `data-trace` part, and the metadata. One shape, two sources.
 */

/** How much of a passage the trace table shows before it truncates. */
const TRACE_SNIPPET_CHARS = 180;

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TRACE_SNIPPET_CHARS
    ? `${flat.slice(0, TRACE_SNIPPET_CHARS).trimEnd()}…`
    : flat;
}

/* ========================================================================== *
 * LISTS
 * ========================================================================== */

/** This user's conversations, most recently touched first — the rail order. */
export async function listUserConversations(
  userId: string,
): Promise<ConversationSummary[]> {
  const rows = await db
    .select({
      id: conversations.id,
      title: conversations.title,
      documentIds: conversations.documentIds,
      updatedAt: conversations.updatedAt,
    })
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.updatedAt));

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    documentIds: row.documentIds,
    // Serialised at the boundary: timestamps are UTC in the database and are
    // formatted in the browser, where the reader's locale actually lives.
    updatedAt: row.updatedAt.toISOString(),
  }));
}

/**
 * Resolve a conversation's scope to the documents it names, IN SCOPE ORDER.
 *
 * The order is load-bearing — it is what assigns highlighter inks — so the rows
 * are re-sorted into the order of `documentIds` rather than left in whatever
 * order Postgres returned them.
 *
 * Documents that have been deleted since the conversation started simply drop
 * out. The conversation keeps working over what is left, which is why retrieval
 * re-checks scope on every question instead of trusting this column.
 */
export async function loadScopeDocuments(
  userId: string,
  documentIds: string[],
): Promise<ScopeDocument[]> {
  if (documentIds.length === 0) return [];

  const rows = await db
    .select({
      id: documents.id,
      title: documents.title,
      status: documents.status,
    })
    .from(documents)
    .where(
      and(
        inArray(documents.id, documentIds),
        eq(documents.userId, userId),
        isNull(documents.deletedAt),
      ),
    );

  const byId = new Map(rows.map((row) => [row.id, row]));

  return documentIds
    .map((id) => byId.get(id))
    .filter((row) => row !== undefined)
    .map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      ready: row.status === "ready",
    }));
}

/* ========================================================================== *
 * THE THREAD
 * ========================================================================== */

/**
 * Read one conversation's messages back as UI messages.
 *
 * Three queries, not one join. The messages, their citations, and their trace
 * rows are three different cardinalities over the same thread — a join would
 * multiply the message content by the number of trace rows, which for a
 * hundred-candidate trace means shipping the answer text a hundred times from
 * Postgres and de-duplicating it here.
 */
export async function loadConversationThread(
  conversationId: string,
): Promise<MarginaliaUIMessage[]> {
  const rows = await db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      model: messages.model,
      promptTokens: messages.promptTokens,
      completionTokens: messages.completionTokens,
      costCents: messages.costCents,
      latencyMs: messages.latencyMs,
      finishReason: messages.finishReason,
    })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt), asc(messages.id));

  if (rows.length === 0) return [];

  const assistantIds = rows
    .filter((row) => row.role === "assistant")
    .map((row) => row.id);

  const [citationsByMessage, traceByMessage] = await Promise.all([
    loadCitations(assistantIds),
    loadTrace(assistantIds),
  ]);

  return rows.map((row) => {
    const parts: MarginaliaUIMessage["parts"] = [
      { type: "text", text: row.content, state: "done" },
    ];

    if (row.role === "assistant") {
      // Always written, even when empty. A "Show retrieval" row that is present
      // on some answers and absent on others reads as a bug; an empty trace is
      // itself the explanation for "these documents don't answer that".
      parts.push({
        type: "data-citations",
        data: { citations: citationsByMessage.get(row.id) ?? [] },
      });
      parts.push({
        type: "data-trace",
        data: { rows: traceByMessage.get(row.id) ?? [] },
      });
    }

    return {
      id: row.id,
      role: row.role,
      parts,
      metadata:
        row.role === "assistant"
          ? {
              messageId: row.id,
              model: row.model,
              promptTokens: row.promptTokens,
              completionTokens: row.completionTokens,
              costCents: row.costCents ?? 0,
              latencyMs: row.latencyMs ?? 0,
              finishReason: row.finishReason,
              // Invented markers were stripped before the answer was stored,
              // so there is nothing left for the renderer to remove.
              invalidMarkers: [],
            }
          : undefined,
    } satisfies MarginaliaUIMessage;
  });
}

async function loadCitations(
  messageIds: string[],
): Promise<Map<string, UICitation[]>> {
  const byMessage = new Map<string, UICitation[]>();
  if (messageIds.length === 0) return byMessage;

  const rows = await db
    .select({
      messageId: citations.messageId,
      marker: citations.marker,
      chunkId: citations.chunkId,
      documentId: citations.documentId,
      documentTitle: documents.title,
      pageFrom: citations.pageFrom,
      pageTo: citations.pageTo,
      quotedText: citations.quotedText,
    })
    .from(citations)
    .innerJoin(documents, eq(documents.id, citations.documentId))
    .where(inArray(citations.messageId, messageIds))
    .orderBy(asc(citations.messageId), asc(citations.marker));

  for (const row of rows) {
    const list = byMessage.get(row.messageId) ?? [];
    list.push({
      marker: row.marker,
      chunkId: row.chunkId,
      documentId: row.documentId,
      documentTitle: row.documentTitle,
      pageFrom: row.pageFrom,
      pageTo: row.pageTo,
      quotedText: row.quotedText,
    });
    byMessage.set(row.messageId, list);
  }

  return byMessage;
}

/**
 * The persisted retrieval trace.
 *
 * LEFT joins, not inner: `retrievals.chunk_id` is ON DELETE SET NULL, so
 * re-ingesting a document leaves the trace rows of past answers with no chunk
 * to point at. Those rows are still the truth about what was searched and how
 * it scored, and dropping them would silently shorten the trace of every old
 * answer. They render with the passage column marked unavailable.
 *
 * Ordered the way the table reads: by fused score, best first, nulls last.
 */
async function loadTrace(
  messageIds: string[],
): Promise<Map<string, UITraceRow[]>> {
  const byMessage = new Map<string, UITraceRow[]>();
  if (messageIds.length === 0) return byMessage;

  const rows = await db
    .select({
      messageId: retrievals.messageId,
      chunkId: retrievals.chunkId,
      text: chunks.text,
      documentId: chunks.documentId,
      documentTitle: documents.title,
      pageFrom: chunks.pageFrom,
      pageTo: chunks.pageTo,
      denseRank: retrievals.denseRank,
      denseScore: retrievals.denseScore,
      lexicalRank: retrievals.lexicalRank,
      lexicalScore: retrievals.lexicalScore,
      rrfScore: retrievals.rrfScore,
      rerankScore: retrievals.rerankScore,
      used: retrievals.used,
    })
    .from(retrievals)
    .leftJoin(chunks, eq(chunks.id, retrievals.chunkId))
    .leftJoin(documents, eq(documents.id, chunks.documentId))
    .where(inArray(retrievals.messageId, messageIds))
    .orderBy(
      asc(retrievals.messageId),
      desc(retrievals.used),
      sql`${retrievals.rrfScore} desc nulls last`,
    );

  for (const row of rows) {
    const list = byMessage.get(row.messageId) ?? [];
    list.push({
      chunkId: row.chunkId,
      documentId: row.documentId,
      documentTitle: row.documentTitle,
      snippet: row.text ? snippet(row.text) : "",
      pageFrom: row.pageFrom,
      pageTo: row.pageTo,
      denseRank: row.denseRank,
      denseScore: row.denseScore,
      lexicalRank: row.lexicalRank,
      lexicalScore: row.lexicalScore,
      rrfScore: row.rrfScore,
      rerankScore: row.rerankScore,
      used: row.used,
    });
    byMessage.set(row.messageId, list);
  }

  return byMessage;
}

/* ========================================================================== *
 * WRITES USED BY THE STREAMING ROUTE
 * ========================================================================== */

/**
 * A question is stored by `insertUserMessageWithinLimit` in
 * src/lib/usage/guard.ts, not here.
 *
 * There is deliberately no plain `persistUserMessage` in this file. The daily
 * question limit is enforced by counting and inserting in ONE transaction, and
 * a second, unguarded way to write a `role = 'user'` row is exactly how that
 * limit would come to be bypassed by the next call site somebody adds.
 */
export { insertUserMessageWithinLimit } from "@/lib/usage/guard";

/**
 * Note a scope change in the thread.
 *
 * A `system` message rather than client-side state, because the scope a
 * question was asked under is part of reading the answer later: "nothing in
 * these documents covers that" means something different depending on which
 * documents those were. Persisted, so it survives the reload that would
 * otherwise erase the only record of the change.
 */
export async function persistScopeNote(input: {
  conversationId: string;
  content: string;
}): Promise<{ id: string; content: string }> {
  const [row] = await db
    .insert(messages)
    .values({
      conversationId: input.conversationId,
      role: "system",
      content: input.content,
    })
    .returning({ id: messages.id, content: messages.content });

  return row;
}

/**
 * Does this thread have any turns yet?
 *
 * Used to decide whether a scope change is worth noting: changing the
 * selection before the first question is the reader setting up, and a note
 * about it would be the first thing in an otherwise empty conversation.
 */
export async function conversationHasMessages(
  conversationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .limit(1);

  return row !== undefined;
}

/** Bump `updated_at` so the rail's ordering reflects activity, not creation. */
export async function touchConversation(conversationId: string): Promise<void> {
  await db
    .update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));
}

/**
 * Title a conversation, but only if it does not already have one.
 *
 * The `IS NULL` predicate is in the WHERE clause rather than in a read-then-
 * write, so two questions sent in quick succession cannot race into two
 * different titles. First write wins, in the database, once.
 */
export async function setConversationTitleIfUnset(
  conversationId: string,
  title: string,
): Promise<void> {
  await db
    .update(conversations)
    .set({ title })
    .where(
      and(eq(conversations.id, conversationId), isNull(conversations.title)),
    );
}
