"use server";

import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
import { del, head } from "@vercel/blob";
import { z } from "zod";

import { db } from "@/db";
import { chunks, documentPages, documents } from "@/db/schema";
import { requireDocumentAccess, requireUser } from "@/lib/auth-server";
import { DEMO_BANNER, isDemoUser } from "@/lib/demo";
import { env } from "@/lib/env";
import {
  LIMITS,
  documentLimitNotice,
  pageLimitNotice,
  type LimitNotice,
} from "@/lib/limits";
import {
  LimitError,
  countUserDocuments,
  countUserPages,
  insertDocumentWithinLimit,
  recordUploadUsage,
} from "@/lib/usage";
import { resumeFailedDocument } from "@/lib/ingest/pipeline";
import {
  readDocumentProgress,
  type DocumentProgress,
} from "@/lib/ingest/progress";
import { startIngestion } from "@/lib/ingest/start";
import { getVectorStore } from "@/lib/vector";
import {
  ACCEPTED_CONTENT_TYPES,
  MAX_UPLOAD_BYTES,
  documentTitleFromFilename,
  isOwnedBlobPathname,
} from "@/lib/upload";

/**
 * Server Actions over the `documents` table.
 *
 * A Server Action is a PUBLIC HTTP ENDPOINT with a generated name. It is not
 * protected by having been imported from one component, and the arguments
 * arrive from the network. So every action here re-establishes the session
 * itself and validates its input with Zod, exactly as a route handler would.
 */

/** What the client claims it just uploaded. All of it is treated as hostile. */
const registerSchema = z.object({
  blobUrl: z.url(),
  pathname: z.string().min(1).max(1024),
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(255),
  byteSize: z.int().positive(),
});

export type RegisterUploadInput = z.input<typeof registerSchema>;

export type ActionResult<T = unknown> =
  | ({ ok: true } & T)
  /**
   * `limit` is present when the refusal was a LIMIT rather than a failure.
   * The two are rendered differently on purpose — an error is a toast, a limit
   * is a dialog naming the ceiling, the current usage, and the way out — so
   * the distinction has to survive the trip to the client rather than being
   * inferred from the wording of a string.
   */
  | { ok: false; error: string; limit?: LimitNotice };

/**
 * Turn a completed blob upload into a `documents` row.
 *
 * THE CLIENT IS NOT TRUSTED. It has just written an object into the store, and
 * everything it says about that object is a claim. So before a row exists:
 *
 *   1. the session is re-read, and `user_id` is stamped from it — never from
 *      the request;
 *   2. the pathname is checked against this user's prefix, so a row can't be
 *      pointed at somebody else's blob;
 *   3. the STORED object is read back with `head()`, and its real content type
 *      and real size are checked against the allowlist, the size cap, and the
 *      claim. A file that lies about being a PDF is caught here even though the
 *      token allowed the content type it declared.
 *
 * A blob that fails verification is DELETED. Leaving it would be a file in the
 * store that no row references, counting against the quota, invisible to the
 * user, and impossible to clean up from the UI.
 */
export async function registerUploadedDocument(
  input: RegisterUploadInput,
): Promise<ActionResult<{ documentId: string }>> {
  const user = await requireUser();

  // The second half of the demo upload block. The token route refuses first,
  // so nothing should reach here — but this action is separately reachable and
  // is what actually writes the row.
  if (isDemoUser(user.id)) {
    return { ok: false, error: DEMO_BANNER.title };
  }

  const parsed = registerSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "That upload could not be recorded." };
  }
  const claim = parsed.data;

  if (!isOwnedBlobPathname(claim.pathname, user.id)) {
    // Not this user's prefix: refuse, and do NOT delete — the object may
    // legitimately belong to somebody else and this request has no business
    // touching it.
    return { ok: false, error: "That upload does not belong to this account." };
  }

  // Read the object as the store actually holds it.
  let stored;
  try {
    stored = await head(claim.blobUrl, { token: env.BLOB_READ_WRITE_TOKEN });
  } catch (error) {
    console.error("[upload] head failed", error);
    return {
      ok: false,
      error: "The uploaded file could not be read back. Try uploading it again.",
    };
  }

  const discard = async (error: string): Promise<ActionResult<never>> => {
    try {
      await del(claim.blobUrl, { token: env.BLOB_READ_WRITE_TOKEN });
    } catch (deleteError) {
      // Worth knowing about — it means an orphan is sitting in the store.
      console.error("[upload] failed to discard rejected blob", deleteError);
    }
    return { ok: false, error };
  };

  const storedType = stored.contentType.split(";")[0].trim().toLowerCase();
  if (!ACCEPTED_CONTENT_TYPES.includes(storedType)) {
    return discard("That file type is not supported.");
  }
  if (storedType !== claim.contentType.split(";")[0].trim().toLowerCase()) {
    return discard("The uploaded file did not match what was sent.");
  }
  if (stored.size > MAX_UPLOAD_BYTES || stored.size !== claim.byteSize) {
    return discard("The uploaded file did not match what was sent.");
  }
  if (stored.size === 0) {
    return discard("That file is empty. There is nothing to read.");
  }

  /*
   * THE DOCUMENT LIMIT IS DECIDED HERE, and it is decided inside the same
   * transaction as the insert.
   *
   * The upload route checked the count before minting a token, but that check
   * cannot be the enforcement: two uploads started together both read the same
   * count, both pass, and both insert. `insertDocumentWithinLimit` takes a
   * per-user advisory lock and then counts and inserts under it, so the 26th
   * document cannot come into existence — see src/lib/usage/guard.ts for why a
   * plain transaction is not enough on its own.
   *
   * A refusal DISCARDS the blob, exactly like a failed verification. The bytes
   * are already in the store and nothing will reference them.
   */
  let documentId: string;
  try {
    documentId = await insertDocumentWithinLimit({
      userId: user.id,
      title: documentTitleFromFilename(claim.filename),
      filename: claim.filename,
      // The STORED values, not the claimed ones.
      mimeType: storedType,
      byteSize: stored.size,
      blobUrl: stored.url,
      blobPathname: stored.pathname,
    });
  } catch (error) {
    if (error instanceof LimitError) {
      const rejected = await discard(error.notice.message);
      return { ...rejected, limit: error.notice };
    }
    console.error("[upload] failed to record document", error);
    return discard("That upload could not be recorded.");
  }

  // Metered after the row exists, so the meter never counts an upload that was
  // discarded. Failing to write the usage row does not fail the upload.
  await recordUploadUsage({ userId: user.id, byteSize: stored.size });

  const created = { id: documentId };

  // The single seam where ingestion is triggered. It schedules extraction to
  // run after this response is sent, so the upload UI is not held open while a
  // large PDF is parsed.
  await startIngestion(created.id, user.id);

  revalidatePath("/app", "layout");
  return { ok: true, documentId: created.id };
}

/**
 * Remove a document, and everything derived from it.
 *
 * ORDER MATTERS, and it is: blob, then vectors, then rows.
 *
 * It runs outward-in, from the copy that costs the most to keep toward the one
 * that everything else is found through. The document row is the index into all
 * of it — the blob URL and the chunk ids are only reachable from there — so if
 * the row went first, a failure at any later step would strand data with
 * nothing left pointing at it. Deleting the row last means every earlier
 * failure is recoverable: the row is still there, still listable, still
 * retryable.
 *
 * NOTHING ABORTS THE SEQUENCE. A blob that will not delete must not keep a
 * document in the user's library forever — that is a storage leak turning into
 * a UI bug. So each step is attempted, failures are collected, and the caller
 * gets back a list of what could not be cleaned up. The user's intent is
 * carried out; the mess is reported rather than hidden.
 *
 * The document row is SOFT-deleted, as the schema requires — it is the only
 * soft-deleted table, and every query filters `deleted_at IS NULL`, so the
 * document leaves the rail, the quota, and retrieval in one write. Pages and
 * chunks are HARD-deleted: they are derived data, they are the bulk of the
 * storage, and they can be rebuilt from the blob if the blob still exists.
 */
export async function deleteDocument(
  documentId: string,
): Promise<ActionResult<{ warnings: string[] }>> {
  const { user, document } = await requireDocumentAccess(documentId);

  /*
   * THE DEMO ACCOUNT CANNOT DELETE. The corpus IS the demo: one visitor
   * removing the HIPAA regulation breaks it for everyone until somebody runs
   * the reset script. Checked after the ownership check, so a demo visitor
   * probing someone else's document id still gets a 404 rather than learning
   * from the wording that the document exists.
   */
  if (isDemoUser(user.id)) {
    return {
      ok: false,
      error: "Deleting is disabled in the demo workspace.",
    };
  }

  const warnings: string[] = [];

  // 1. THE BLOB. The only copy of the original file, and the only one costing
  //    storage that the user is not otherwise paying for.
  try {
    await del(document.blobUrl, { token: env.BLOB_READ_WRITE_TOKEN });
  } catch (error) {
    console.error("[documents] failed to delete blob", document.id, error);
    warnings.push("the stored file");
  }

  // 2. THE VECTORS, by document_id filter. Left behind, these would be points
  //    in a shared collection belonging to a document that no longer exists —
  //    unreachable through search, since every search also filters on
  //    documents the user still owns, but occupying the free tier's quota
  //    indefinitely.
  try {
    await getVectorStore().deleteByDocument(document.id);
  } catch (error) {
    console.error("[documents] failed to delete vectors", document.id, error);
    warnings.push("the search index entries");
  }

  // 3. THE ROWS. Pages and chunks go for real; the document is soft-deleted.
  try {
    await db.transaction(async (tx) => {
      await tx.delete(chunks).where(eq(chunks.documentId, document.id));
      await tx
        .delete(documentPages)
        .where(eq(documentPages.documentId, document.id));
      await tx
        .update(documents)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(documents.id, document.id),
            eq(documents.userId, user.id),
            isNull(documents.deletedAt),
          ),
        );
    });
  } catch (error) {
    // The one step whose failure leaves the document visible. Report it as a
    // failure rather than a warning, because nothing was removed from the
    // user's point of view.
    console.error("[documents] failed to delete rows", document.id, error);
    return {
      ok: false,
      error: "That document could not be removed. Try again in a moment.",
    };
  }

  revalidatePath("/app", "layout");
  return { ok: true, warnings };
}

/**
 * Re-run ingestion for a document that failed, FROM WHERE IT FAILED.
 *
 * `documents.failed_stage` records the stage that threw, and
 * `resumeFailedDocument` simply sets the status back to it. That is the whole
 * repair: the status column IS the pipeline's cursor, so moving it is the same
 * as seeking.
 *
 * Resuming rather than restarting is not an optimisation. A 200-page contract
 * that failed while embedding passage 400 has already been downloaded, parsed,
 * and split; redoing that is minutes of function time and a second full read of
 * the blob, for a result identical to what is already in the database. What
 * makes it safe is that every stage is idempotent — the work already done is
 * either kept or replaced wholesale, never appended to.
 */
export async function retryIngestion(
  documentId: string,
): Promise<ActionResult<{ resumedAt: string }>> {
  const { user, document } = await requireDocumentAccess(documentId);

  const resumedAt = await resumeFailedDocument(document.id, user.id);
  await startIngestion(document.id, user.id);

  revalidatePath("/app", "layout");
  return { ok: true, resumedAt };
}

/**
 * Poll one document's ingestion progress.
 *
 * A Server Action rather than a route handler so the session check is the same
 * one every other action uses, and so the client calls it as a function instead
 * of hand-rolling a fetch. `requireDocumentAccess` 404s identically whether the
 * document is missing or belongs to someone else, so polling cannot be used to
 * discover another user's document ids.
 */
export async function getDocumentProgress(
  documentId: string,
): Promise<ActionResult<{ progress: DocumentProgress }>> {
  const { user, document } = await requireDocumentAccess(documentId);

  const progress = await readDocumentProgress(document.id, user.id);
  if (!progress) {
    return { ok: false, error: "That document no longer exists." };
  }

  return { ok: true, progress };
}

/**
 * Can this account take `count` more documents right now?
 *
 * Called by the upload queue BEFORE it starts transferring, so a user at the
 * ceiling gets the dialog that names it instead of watching a 25 MB upload
 * complete and then fail. It is a courtesy, not the enforcement — see
 * `insertDocumentWithinLimit` for the check that actually decides — and it is
 * deliberately not transactional, because nothing is being written.
 *
 * It also answers the page ceiling, which the register step cannot: pages are
 * only counted once a document has been parsed, so the only useful thing to
 * say at upload time is whether there is any room left at all.
 */
export async function checkUploadAllowance(
  count = 1,
): Promise<ActionResult<{ documentsRemaining: number; pagesRemaining: number }>> {
  const user = await requireUser();

  // Refused before a byte moves, with the banner's own sentence, so the
  // dropzone's message and the server's agree.
  if (isDemoUser(user.id)) {
    return { ok: false, error: DEMO_BANNER.title };
  }

  const [used, pages] = await Promise.all([
    countUserDocuments(user.id),
    countUserPages(user.id),
  ]);

  if (used + count > LIMITS.documents) {
    const notice = documentLimitNotice(used);
    return { ok: false, error: notice.message, limit: notice };
  }

  if (pages >= LIMITS.totalPages) {
    const notice = pageLimitNotice(pages, 1);
    return { ok: false, error: notice.message, limit: notice };
  }

  return {
    ok: true,
    documentsRemaining: LIMITS.documents - used,
    pagesRemaining: LIMITS.totalPages - pages,
  };
}
