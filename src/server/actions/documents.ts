"use server";

import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
import { del, head } from "@vercel/blob";
import { z } from "zod";

import { db } from "@/db";
import { documents } from "@/db/schema";
import { requireDocumentAccess, requireUser } from "@/lib/auth-server";
import { countUserDocuments } from "@/lib/documents";
import { env } from "@/lib/env";
import { startIngestion } from "@/lib/ingest/start";
import {
  ACCEPTED_CONTENT_TYPES,
  MAX_DOCUMENTS_PER_USER,
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
  | { ok: false; error: string };

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

  // Re-check the quota. The upload route checked it before minting a token,
  // but two uploads started in parallel can both pass that check; this is the
  // one that runs immediately before the row is written.
  const used = await countUserDocuments(user.id);
  if (used >= MAX_DOCUMENTS_PER_USER) {
    return discard(
      `You have ${used} documents, which is the limit of ${MAX_DOCUMENTS_PER_USER}. Delete one to upload another.`,
    );
  }

  const [created] = await db
    .insert(documents)
    .values({
      userId: user.id,
      title: documentTitleFromFilename(claim.filename),
      filename: claim.filename,
      // The STORED values, not the claimed ones.
      mimeType: storedType,
      byteSize: stored.size,
      blobUrl: stored.url,
      blobPathname: stored.pathname,
      status: "uploaded",
    })
    .returning({ id: documents.id });

  if (!created) {
    return discard("That upload could not be recorded.");
  }

  // The single seam where ingestion is triggered. Currently a no-op: the
  // document sits in `uploaded` until the extraction stage lands.
  await startIngestion(created.id);

  revalidatePath("/app", "layout");
  return { ok: true, documentId: created.id };
}

/**
 * Remove a document.
 *
 * The ROW is soft-deleted — `documents` is the only soft-deleted table in the
 * schema, and every query filters `deleted_at IS NULL`, so the document leaves
 * the rail, the quota, and retrieval in one write. The BLOB is hard-deleted,
 * because storage is the thing actually being freed and there is nothing to
 * recover it for once the row is gone.
 *
 * Ownership is proved by `requireDocumentAccess`, which 404s identically
 * whether the document is missing or belongs to someone else.
 */
export async function deleteDocument(
  documentId: string,
): Promise<ActionResult> {
  const { user, document } = await requireDocumentAccess(documentId);

  await db
    .update(documents)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(documents.id, document.id),
        eq(documents.userId, user.id),
        isNull(documents.deletedAt),
      ),
    );

  try {
    await del(document.blobUrl, { token: env.BLOB_READ_WRITE_TOKEN });
  } catch (error) {
    // The row is already gone from the user's view; a stranded blob is a
    // storage leak to clean up, not a failure to report back.
    console.error("[documents] failed to delete blob", error);
  }

  revalidatePath("/app", "layout");
  return { ok: true };
}
