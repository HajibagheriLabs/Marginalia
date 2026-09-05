"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { conversations } from "@/db/schema";
import type { ConversationSummary, ScopeDocument } from "@/lib/chat/types";
import { suggestQuestions, type Suggestion } from "@/lib/chat/suggestions";
import {
  filterOwnedDocumentIds,
  requireConversationAccess,
  requireUser,
} from "@/lib/auth-server";
import {
  conversationHasMessages,
  loadScopeDocuments,
  persistScopeNote,
} from "@/lib/conversations";

/**
 * Server Actions over `conversations`.
 *
 * Same standing rule as the document actions: a Server Action is a PUBLIC HTTP
 * endpoint with a generated name, so every one of these re-establishes the
 * session itself and validates its input with Zod. Being imported by exactly
 * one component protects nothing.
 *
 * Note what is NOT here: sending a question. That is a route handler, because
 * it streams — see src/app/api/chat/route.ts. Everything in this file is a
 * discrete write that finishes before it answers.
 */

export type ActionResult<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

const idSchema = z.uuid();
const documentIdsSchema = z.array(z.uuid()).max(50);
/** Long enough for a real sentence, short enough that the rail stays a rail. */
const titleSchema = z.string().trim().min(1).max(120);

/* ========================================================================== *
 * CREATE
 * ========================================================================== */

/**
 * Start a conversation over a set of documents.
 *
 * The title is left NULL. It is filled in from the first question by the chat
 * route, once, and the rail renders an untitled conversation as "New
 * conversation" — so a thread that is created and abandoned never acquires a
 * name it did not earn.
 *
 * Scope is FILTERED, not validated: an id the user does not own is dropped
 * rather than refused, for the same reason `requireDocumentAccess` answers 404
 * instead of 403. Refusing would confirm the id exists.
 */
export async function createConversation(
  documentIds: string[],
): Promise<ActionResult<{ conversation: ConversationSummary }>> {
  const user = await requireUser();

  const parsed = documentIdsSchema.safeParse(documentIds);
  if (!parsed.success) {
    return { ok: false, error: "That document selection is not valid." };
  }

  const scope = await filterOwnedDocumentIds(user.id, parsed.data);

  const [row] = await db
    .insert(conversations)
    .values({ userId: user.id, documentIds: scope })
    .returning({
      id: conversations.id,
      title: conversations.title,
      documentIds: conversations.documentIds,
      updatedAt: conversations.updatedAt,
    });

  revalidatePath("/app", "layout");
  return {
    ok: true,
    conversation: {
      id: row.id,
      title: row.title,
      documentIds: row.documentIds,
      updatedAt: row.updatedAt.toISOString(),
    },
  };
}

/* ========================================================================== *
 * SCOPE
 * ========================================================================== */

/**
 * Change which documents a conversation searches, mid-thread.
 *
 * Allowed, and NOTED. The note is a persisted `system` message rather than a
 * client-side banner because the scope a question was asked under is part of
 * reading its answer later: "nothing in these documents covers that" means
 * something different depending on which documents those were. A note that
 * lived only in React state would vanish on reload and leave the thread
 * looking as though the scope had always been what it is now.
 *
 * RETAINED IDS KEEP THEIR POSITION. Ink is assigned positionally from this
 * array, so rebuilding it in the client's order would re-colour documents that
 * did not change. New ids are appended.
 */
export async function setConversationScope(
  conversationId: string,
  documentIds: string[],
): Promise<
  ActionResult<{
    scope: ScopeDocument[];
    /** Null when nothing actually changed. */
    note: { id: string; content: string } | null;
  }>
> {
  const parsedId = idSchema.safeParse(conversationId);
  const parsedDocuments = documentIdsSchema.safeParse(documentIds);
  if (!parsedId.success || !parsedDocuments.success) {
    return { ok: false, error: "That selection could not be applied." };
  }

  const { user, conversation } = await requireConversationAccess(parsedId.data);
  const requested = await filterOwnedDocumentIds(user.id, parsedDocuments.data);
  const requestedSet = new Set(requested);

  const retained = conversation.documentIds.filter((id) => requestedSet.has(id));
  const retainedSet = new Set(retained);
  const added = requested.filter((id) => !retainedSet.has(id));
  const removed = conversation.documentIds.filter((id) => !requestedSet.has(id));

  const next = [...retained, ...added];

  if (added.length === 0 && removed.length === 0) {
    return {
      ok: true,
      scope: await loadScopeDocuments(user.id, next),
      note: null,
    };
  }

  await db
    .update(conversations)
    .set({ documentIds: next, updatedAt: new Date() })
    .where(eq(conversations.id, conversation.id));

  const scope = await loadScopeDocuments(user.id, next);

  // Only note the change if there is a thread to place it against. A scope
  // change before the first question is the reader setting up, not an event.
  const note = (await conversationHasMessages(conversation.id))
    ? await persistScopeNote({
        conversationId: conversation.id,
        content: scopeNote({
          added: await titlesFor(user.id, added),
          removed: await titlesFor(user.id, removed),
          remaining: scope.length,
        }),
      })
    : null;

  revalidatePath("/app", "layout");
  return { ok: true, scope, note };
}

async function titlesFor(userId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await loadScopeDocuments(userId, ids);
  return rows.map((row) => row.title);
}

/**
 * The wording of the note.
 *
 * Plain verbs, sentence case, states what changed and what is searched now.
 * The count at the end is the part that matters when scrolling back: it tells
 * the reader how to read every answer below the line.
 */
function scopeNote(input: {
  added: string[];
  removed: string[];
  remaining: number;
}): string {
  const clauses: string[] = [];
  if (input.added.length > 0) clauses.push(`Added ${list(input.added)}`);
  if (input.removed.length > 0) clauses.push(`Removed ${list(input.removed)}`);

  const scope =
    input.remaining === 0
      ? "No documents are selected."
      : input.remaining === 1
        ? "Answers below search 1 document."
        : `Answers below search ${input.remaining} documents.`;

  return `${clauses.join(". ")}. ${scope}`;
}

function list(titles: string[]): string {
  if (titles.length === 1) return titles[0];
  if (titles.length === 2) return `${titles[0]} and ${titles[1]}`;
  return `${titles.slice(0, -1).join(", ")}, and ${titles[titles.length - 1]}`;
}

/* ========================================================================== *
 * RENAME / DELETE
 * ========================================================================== */

export async function renameConversation(
  conversationId: string,
  title: string,
): Promise<ActionResult<{ title: string }>> {
  const parsedId = idSchema.safeParse(conversationId);
  const parsedTitle = titleSchema.safeParse(title);
  if (!parsedId.success) {
    return { ok: false, error: "That conversation could not be renamed." };
  }
  if (!parsedTitle.success) {
    return { ok: false, error: "A conversation needs a name of 1 to 120 characters." };
  }

  const { conversation } = await requireConversationAccess(parsedId.data);

  await db
    .update(conversations)
    .set({ title: parsedTitle.data })
    .where(eq(conversations.id, conversation.id));

  revalidatePath("/app", "layout");
  return { ok: true, title: parsedTitle.data };
}

/**
 * Delete a conversation and everything under it.
 *
 * A hard delete, unlike documents. `documents` is soft-deleted because it is
 * the anchor for blobs, vectors, and chunks that are expensive to rebuild and
 * whose cleanup can fail halfway. A conversation owns nothing outside Postgres:
 * messages, citations, and retrieval rows all cascade from this row in one
 * statement, so there is no partial state to recover from and no reason to keep
 * a tombstone the user cannot see.
 */
export async function deleteConversation(
  conversationId: string,
): Promise<ActionResult> {
  const parsed = idSchema.safeParse(conversationId);
  if (!parsed.success) {
    return { ok: false, error: "That conversation could not be deleted." };
  }

  const { conversation } = await requireConversationAccess(parsed.data);

  await db.delete(conversations).where(eq(conversations.id, conversation.id));

  revalidatePath("/app", "layout");
  return { ok: true };
}

/* ========================================================================== *
 * SUGGESTIONS
 * ========================================================================== */

/**
 * The three example questions shown above an empty thread.
 *
 * A Server Action rather than props, because the scope selector can change the
 * selection without a navigation, and examples derived from documents that are
 * no longer selected would be worse than none.
 */
export async function getSuggestedQuestions(
  documentIds: string[],
): Promise<ActionResult<{ suggestions: Suggestion[] }>> {
  const user = await requireUser();

  const parsed = documentIdsSchema.safeParse(documentIds);
  if (!parsed.success) return { ok: true, suggestions: [] };

  return {
    ok: true,
    suggestions: await suggestQuestions(user.id, parsed.data),
  };
}
