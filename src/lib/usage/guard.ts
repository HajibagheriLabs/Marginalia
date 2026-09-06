import { and, eq, gte, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import { conversations, documentPages, documents, messages } from "@/db/schema";
import {
  LIMITS,
  documentLimitNotice,
  messageLimitNotice,
  pageLimitNotice,
  startOfNextUtcDay,
  startOfUtcDay,
  type LimitNotice,
} from "@/lib/limits";

/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ ENFORCEMENT. Every durable limit is checked INSIDE the transaction that  │
 * │ performs the write it constrains.                                        │
 * │                                                                          │
 * │ THE RACE THIS EXISTS TO CLOSE.                                           │
 * │                                                                          │
 * │ The obvious shape is "count, compare, insert":                           │
 * │                                                                          │
 * │     const used = await countUserDocuments(userId);   // 24               │
 * │     if (used >= 25) refuse();                                            │
 * │     await db.insert(documents)...                    // 25               │
 * │                                                                          │
 * │ Two requests arriving together both read 24, both pass, and both insert. │
 * │ The account now holds 26 documents and no code ever ran that would say   │
 * │ so. It is not a rare interleaving either — a drop of ten files at the    │
 * │ quota boundary, or a double-click on send, produces it reliably.         │
 * │                                                                          │
 * │ Wrapping the count and the insert in one transaction does NOT fix it.    │
 * │ Postgres defaults to READ COMMITTED, under which two concurrent          │
 * │ transactions each see a snapshot without the other's uncommitted row and │
 * │ both still count 24. Counting rows is not a conflict, so nothing         │
 * │ serialises them.                                                         │
 * │                                                                          │
 * │ THE FIX: a per-user ADVISORY TRANSACTION LOCK, taken as the first        │
 * │ statement of the transaction. `pg_advisory_xact_lock` blocks a second    │
 * │ transaction holding the same key until the first commits or rolls back,  │
 * │ and releases automatically at either — no unlock to forget, no lock left │
 * │ behind by a crashed function. So the count-and-insert becomes atomic     │
 * │ against every other writer for THAT user, and against nobody else:       │
 * │ different users hash to different keys and never wait on each other.     │
 * │                                                                          │
 * │ It also survives Neon's pooler. Advisory XACT locks are scoped to the    │
 * │ transaction rather than the session, which is exactly what PgBouncer's   │
 * │ transaction-pooling mode preserves. Session-scoped `pg_advisory_lock`    │
 * │ would be the version that breaks there.                                  │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

/**
 * A refusal the interface should render as a DIALOG, not a toast.
 *
 * Carries the whole `LimitNotice` — the ceiling, the current usage, and the
 * next step — so the caller never has to reconstruct any of it from a string.
 * `message` is set to the notice's own sentence so that a handler which only
 * knows about `Error` still says something true.
 */
export class LimitError extends Error {
  readonly notice: LimitNotice;

  constructor(notice: LimitNotice) {
    super(`${notice.message} ${notice.nextStep}`);
    this.name = "LimitError";
    this.notice = notice;
  }
}

/**
 * Serialise every limit check for one user.
 *
 * One key per user, covering ALL of that user's limits rather than one key per
 * limit. Uploading and asking a question do not contend in practice, and a
 * single key is one fewer thing to get wrong — two keys derived from the same
 * id are also two chances for a deadlock if a future caller ever takes both.
 *
 * `hashtextextended` is IMMUTABLE and stable across sessions, which a plain
 * `hashtext` cast is not guaranteed to be across major versions. The seed is 0
 * and must stay 0: changing it would re-key every lock and briefly let two
 * writers past each other during a deploy.
 */
async function lockUser(
  tx: Pick<typeof db, "execute">,
  userId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`marginalia:user:${userId}`}, 0))`,
  );
}

/* ========================================================================== *
 * DOCUMENTS — 25 per user
 * ========================================================================== */

/**
 * Insert a document row, or refuse because the account is full.
 *
 * The count and the insert are one transaction under the user's lock, so the
 * 26th document cannot exist. The Blob upload route ALSO checks this before
 * minting a token — that check is a courtesy that fails fast and saves the
 * user a 25 MB transfer, not a second enforcement point. This one is the
 * decision.
 */
export async function insertDocumentWithinLimit(values: {
  userId: string;
  title: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  blobUrl: string;
  blobPathname: string;
}): Promise<string> {
  return db.transaction(async (tx) => {
    await lockUser(tx, values.userId);

    const [{ used }] = await tx
      .select({ used: sql<number>`count(*)::int` })
      .from(documents)
      .where(
        and(eq(documents.userId, values.userId), isNull(documents.deletedAt)),
      );

    if (used >= LIMITS.documents) {
      // Throwing rolls the transaction back and releases the lock. There is
      // nothing to undo — the insert has not run.
      throw new LimitError(documentLimitNotice(used));
    }

    const [created] = await tx
      .insert(documents)
      .values({ ...values, status: "uploaded" })
      .returning({ id: documents.id });

    return created.id;
  });
}

/** How many documents this account holds. For pre-checks and the settings page. */
export async function countUserDocuments(userId: string): Promise<number> {
  const [row] = await db
    .select({ used: sql<number>`count(*)::int` })
    .from(documents)
    .where(and(eq(documents.userId, userId), isNull(documents.deletedAt)));

  return row?.used ?? 0;
}

/* ========================================================================== *
 * PAGES — 2,000 per user
 * ========================================================================== */

/**
 * Refuse an extraction that would push the account past the page ceiling.
 *
 * CALLED INSIDE the extraction stage's transaction, after that stage has
 * deleted this document's previous pages and before it inserts the new ones.
 * The ordering is what makes a re-extraction free: the document's own old
 * pages are already gone from the count, so re-running a 400-page document
 * measures it once rather than twice.
 *
 * Why here and not at upload: a file's page count is not known until it has
 * been parsed. A 25 MB PDF may hold 40 pages or 4,000, and nothing in the
 * upload request distinguishes them. Checking earlier would mean guessing, and
 * a guessed limit either blocks valid uploads or fails to block the ones that
 * matter. The upload route still refuses when the account is ALREADY at the
 * ceiling, which catches the common case before a byte moves.
 *
 * The refusal surfaces as a failed document with a "Retry" action, because
 * that is what it is: the file is intact in the store, and deleting something
 * else makes the retry succeed.
 */
export async function assertPageAllowance(
  tx: Pick<typeof db, "execute" | "select">,
  userId: string,
  incomingPages: number,
): Promise<void> {
  await lockUser(tx, userId);

  const [{ used }] = await tx
    .select({ used: sql<number>`count(*)::int` })
    .from(documentPages)
    .innerJoin(documents, eq(documentPages.documentId, documents.id))
    .where(and(eq(documents.userId, userId), isNull(documents.deletedAt)));

  if (used + incomingPages > LIMITS.totalPages) {
    throw new LimitError(pageLimitNotice(used, incomingPages));
  }
}

/** Pages across every document this account holds. */
export async function countUserPages(userId: string): Promise<number> {
  const [row] = await db
    .select({ used: sql<number>`count(*)::int` })
    .from(documentPages)
    .innerJoin(documents, eq(documentPages.documentId, documents.id))
    .where(and(eq(documents.userId, userId), isNull(documents.deletedAt)));

  return row?.used ?? 0;
}

/* ========================================================================== *
 * MESSAGES — 100 questions per UTC day
 * ========================================================================== */

/**
 * Persist a question, or refuse because the day's allowance is spent.
 *
 * Counts `role = 'user'` rows only. A regenerate after a model failure reuses
 * the question that is already stored and never reaches this function, so
 * retrying a failed answer does not cost a second question — which it should
 * not, since the user asked once.
 *
 * The count is scoped by joining through `conversations` to `user_id`, the
 * one-hop ownership path the schema defines. Counting by conversation would
 * miss a user who spreads a hundred questions across ten threads.
 */
export async function insertUserMessageWithinLimit(input: {
  userId: string;
  conversationId: string;
  content: string;
}): Promise<string> {
  const since = startOfUtcDay();

  return db.transaction(async (tx) => {
    await lockUser(tx, input.userId);

    const [{ used }] = await tx
      .select({ used: sql<number>`count(*)::int` })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(
        and(
          eq(conversations.userId, input.userId),
          eq(messages.role, "user"),
          gte(messages.createdAt, since),
        ),
      );

    if (used >= LIMITS.messagesPerDay) {
      throw new LimitError(messageLimitNotice(used, startOfNextUtcDay()));
    }

    const [row] = await tx
      .insert(messages)
      .values({
        conversationId: input.conversationId,
        role: "user",
        content: input.content,
      })
      .returning({ id: messages.id });

    return row.id;
  });
}

/** Questions asked since UTC midnight. For the composer hint and settings. */
export async function countQuestionsToday(userId: string): Promise<number> {
  const [row] = await db
    .select({ used: sql<number>`count(*)::int` })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(
      and(
        eq(conversations.userId, userId),
        eq(messages.role, "user"),
        gte(messages.createdAt, startOfUtcDay()),
      ),
    );

  return row?.used ?? 0;
}
