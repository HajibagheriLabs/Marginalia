import { cache } from "react";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { conversations, documents } from "@/db/schema";

import { auth, type Session, type SessionUser } from "./auth";

/**
 * THE OWNERSHIP BOUNDARY.
 *
 * Every read or write of an owned row goes through one of the `require*`
 * helpers below. Feature code must never query `documents` or `conversations`
 * by id on its own — the whole point of funnelling through here is that the
 * `user_id` predicate cannot be forgotten at a call site.
 *
 * Missing and forbidden are answered identically, with a 404.
 *
 * That is not tidiness. A 403 says "this row exists, but it isn't yours",
 * which turns a document id into an oracle: an attacker who can enumerate ids
 * learns which ones are real and roughly how many documents other people have.
 * A 404 says only "there is nothing here for you", which is all a caller is
 * entitled to know. The same rule applies to the vector store — see the
 * payload filter in src/lib/vector/.
 */

/** Ids come from URLs, so they are attacker-controlled until proven otherwise. */
const uuidSchema = z.uuid();

/**
 * The current session, or null.
 *
 * Wrapped in React's `cache` so that a page, its layout, and any Server
 * Component beneath them share ONE session lookup per request instead of
 * hitting Postgres once each. The cache is per-request; it never leaks between
 * users.
 */
export const getSession = cache(async (): Promise<Session | null> => {
  return auth.api.getSession({ headers: await headers() });
});

/** The current user, or null. Convenience over `getSession`. */
export async function getUser(): Promise<SessionUser | null> {
  const session = await getSession();
  return session?.user ?? null;
}

/**
 * The current user, or a redirect to /sign-in.
 *
 * Call this at the top of every authenticated page, Server Action, and route
 * handler. `redirect()` throws, so nothing after it runs.
 */
export async function requireUser(): Promise<SessionUser> {
  const user = await getUser();
  if (!user) redirect("/sign-in");
  return user;
}

/**
 * Load a document and prove the caller owns it.
 *
 * Returns the row, so the caller never needs a second query — and never has a
 * reason to write one without the ownership predicate.
 *
 * 404s when: the id isn't a uuid, no such document exists, it belongs to
 * someone else, or it has been soft-deleted. The caller cannot tell these
 * apart, which is the point.
 */
export async function requireDocumentAccess(documentId: string) {
  const user = await requireUser();

  // A malformed id would otherwise reach Postgres and raise a type error,
  // which is a slower and noisier way of saying "not found".
  const parsed = uuidSchema.safeParse(documentId);
  if (!parsed.success) notFound();

  const [document] = await db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.id, parsed.data),
        eq(documents.userId, user.id),
        isNull(documents.deletedAt),
      ),
    )
    .limit(1);

  if (!document) notFound();
  return { user, document };
}

/**
 * Load a conversation and prove the caller owns it.
 *
 * Note what this does NOT do: it does not check that the documents listed in
 * `conversation.documentIds` are still owned by this user. Scope is re-checked
 * at retrieval time, because a conversation's document list can go stale — a
 * document may have been deleted since the thread started.
 */
export async function requireConversationAccess(conversationId: string) {
  const user = await requireUser();

  const parsed = uuidSchema.safeParse(conversationId);
  if (!parsed.success) notFound();

  const [conversation] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.id, parsed.data),
        eq(conversations.userId, user.id),
      ),
    )
    .limit(1);

  if (!conversation) notFound();
  return { user, conversation };
}

/**
 * Narrow a caller-supplied list of document ids to the ones this user actually
 * owns and that are ready to search.
 *
 * Used when a request names its own retrieval scope. Unlike the helpers above
 * this filters rather than 404s: asking about a document you don't own is
 * indistinguishable from asking about one that doesn't exist, so the id is
 * simply dropped from the scope.
 */
export async function filterOwnedDocumentIds(
  userId: string,
  documentIds: string[],
): Promise<string[]> {
  const valid = documentIds.filter((id) => uuidSchema.safeParse(id).success);
  if (valid.length === 0) return [];

  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.userId, userId), isNull(documents.deletedAt)));

  const owned = new Set(rows.map((row) => row.id));
  return valid.filter((id) => owned.has(id));
}
