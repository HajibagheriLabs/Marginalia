"use server";

import { revalidatePath } from "next/cache";
import { eq, inArray, sql } from "drizzle-orm";
import { del } from "@vercel/blob";
import { z } from "zod";

import { db } from "@/db";
import {
  chunks,
  conversations,
  documentPages,
  documents,
  usageEvents,
} from "@/db/schema";
import { DELETE_CONFIRMATION } from "@/lib/account";
import { requireUser } from "@/lib/auth-server";
import { isDemoUser } from "@/lib/demo";
import { env } from "@/lib/env";
import { getVectorStore } from "@/lib/vector";

import type { ActionResult } from "./documents";

/**
 * Account-level actions.
 *
 * A Server Action is a PUBLIC HTTP ENDPOINT with a generated name, so this
 * re-establishes the session itself and validates its input with Zod, exactly
 * as a route handler would.
 */

/**
 * The typed confirmation, re-checked on the server.
 *
 * The word itself lives in src/lib/account.ts because a "use server" module
 * may only export async functions — and because the dialog and the action have
 * to agree on it, which means exactly one definition.
 */
const deleteAllSchema = z.object({
  confirmation: z.literal(DELETE_CONFIRMATION),
});

export interface DeleteAllSummary {
  documents: number;
  conversations: number;
  usageEvents: number;
  /** What could not be removed, in plain words. Empty when everything went. */
  warnings: string[];
}

/**
 * ERASE EVERYTHING THIS ACCOUNT HAS PUT INTO THE APPLICATION.
 *
 * Documents, their pages and passages, their vectors, their stored files, every
 * conversation and every answer inside it, and the usage meter. What survives
 * is the account itself — email, password, sessions — because "delete my data"
 * and "close my account" are different requests and only one of them was made.
 * Signing back in afterwards lands on an empty library, which is the honest
 * result.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ORDER: BLOBS → VECTORS → ROWS.
 *
 * Outward-in, from the copies that live outside Postgres toward the rows that
 * are the only way to find them. The `documents` rows hold the blob URLs; the
 * `user_id` payload is what makes the vectors findable. Deleting the rows first
 * would strand both with nothing left pointing at them — an unreferenced file
 * in the store and a user's text still embedded in a shared collection, after
 * they asked for it to be gone.
 *
 * NOTHING ABORTS THE SEQUENCE. A blob that will not delete must not stop the
 * conversations from being deleted. Each step is attempted, failures are
 * collected, and the caller is told exactly what could not be cleaned up. The
 * request is carried out; the mess is reported rather than hidden.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THIS IS A HARD DELETE, INCLUDING THE DOCUMENTS.
 *
 * `documents` is soft-deleted everywhere else in this codebase, and that is
 * right for "remove this from my library" — a soft delete is reversible and it
 * keeps citations in old conversations readable. It is exactly wrong here.
 * "Delete all my data" that leaves every row in place with a timestamp set is
 * not a deletion, and a user who asked for erasure and got a flag would be
 * entitled to be angry about it. The conversations that cited those documents
 * are being deleted in the same breath, so nothing is left pointing at them.
 */
export async function deleteAllMyData(
  input: z.input<typeof deleteAllSchema>,
): Promise<ActionResult<{ summary: DeleteAllSummary }>> {
  const user = await requireUser();

  // The demo's data is the demo. Erasing it is the reset script's job, and the
  // reset script runs as an operator rather than as a visitor.
  if (isDemoUser(user.id)) {
    return {
      ok: false,
      error: "Deleting is disabled in the demo workspace.",
    };
  }

  const parsed = deleteAllSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Type ${DELETE_CONFIRMATION} to confirm.`,
    };
  }

  const warnings: string[] = [];

  // Read the inventory BEFORE deleting any of it. These lists are both the
  // work queue for the blob deletes and the numbers reported back afterwards.
  const owned = await db
    .select({ id: documents.id, blobUrl: documents.blobUrl })
    .from(documents)
    .where(eq(documents.userId, user.id));

  const threads = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.userId, user.id));

  const [meter] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(usageEvents)
    .where(eq(usageEvents.userId, user.id));

  /* ── 1. THE STORED FILES ──────────────────────────────────────────────── */
  // Sequential rather than a `Promise.all`: this is a handful of deletes at
  // most, and one failure must not reject the batch and hide the others.
  let blobFailures = 0;
  for (const document of owned) {
    try {
      await del(document.blobUrl, { token: env.BLOB_READ_WRITE_TOKEN });
    } catch (error) {
      console.error("[account] failed to delete blob", document.id, error);
      blobFailures += 1;
    }
  }
  if (blobFailures > 0) {
    warnings.push(
      `${blobFailures} stored ${blobFailures === 1 ? "file" : "files"}`,
    );
  }

  /* ── 2. THE VECTORS ───────────────────────────────────────────────────── */
  // One filtered delete on `user_id`, not a loop over documents — see the
  // comment on `deleteByUser`. A loop can only erase what the document list
  // knows about.
  try {
    await getVectorStore().deleteByUser(user.id);
  } catch (error) {
    console.error("[account] failed to delete vectors", error);
    warnings.push("the search index entries");
  }

  /* ── 3. THE ROWS ──────────────────────────────────────────────────────── */
  //
  // One transaction: either this account's data is gone or none of it is.
  // Chunks, pages, messages, citations, and retrievals all cascade from the
  // rows deleted here, so they are not listed individually — the foreign keys
  // are declared ON DELETE CASCADE precisely so this cannot be got wrong by
  // forgetting a table.
  //
  // The two explicit deletes below are the exceptions: `chunks` and
  // `document_pages` cascade from `documents` and would go anyway, but naming
  // them keeps the order deterministic under the citation FKs that are
  // ON DELETE SET NULL.
  try {
    await db.transaction(async (tx) => {
      const documentIds = owned.map((document) => document.id);

      if (documentIds.length > 0) {
        await tx.delete(chunks).where(inArray(chunks.documentId, documentIds));
        await tx
          .delete(documentPages)
          .where(inArray(documentPages.documentId, documentIds));
      }

      await tx.delete(conversations).where(eq(conversations.userId, user.id));
      await tx.delete(documents).where(eq(documents.userId, user.id));
      await tx.delete(usageEvents).where(eq(usageEvents.userId, user.id));
    });
  } catch (error) {
    console.error("[account] failed to delete rows", error);
    return {
      ok: false,
      error:
        "Your data could not be deleted. Nothing was removed from the database — try again in a moment.",
    };
  }

  revalidatePath("/app", "layout");

  return {
    ok: true,
    summary: {
      documents: owned.length,
      conversations: threads.length,
      usageEvents: meter?.total ?? 0,
      warnings,
    },
  };
}
