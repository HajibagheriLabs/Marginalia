import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/db";
import { documents } from "@/db/schema";
import { getUser } from "@/lib/auth-server";
import { readDocumentBlob } from "@/lib/blob";
import { ACCEPTED_CONTENT_TYPES } from "@/lib/upload";

/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THE ORIGINAL FILE, SERVED FROM THIS ORIGIN.                              │
 * │                                                                          │
 * │ THE BUG THIS FIXES. `documents.blob_url` used to travel to the browser   │
 * │ as both the viewer's `file` and the toolbar's download href. The store   │
 * │ is configured for PRIVATE access — every server-side read passes the     │
 * │ read-write token — so that URL is not fetchable by a browser at all.     │
 * │ The PDF viewer failed to load every document and the download link 404'd,│
 * │ and neither failure was visible in local development against a store     │
 * │ left public.                                                             │
 * │                                                                          │
 * │ IT IS ALSO THE RIGHT SHAPE ON PURPOSE, not just the working one:         │
 * │                                                                          │
 * │  1. AUTHORIZATION. A blob URL is a bearer capability — whoever holds the │
 * │     string holds the file, forever, with no session and no revocation.   │
 * │     This route re-reads the session and the `user_id` predicate on every │
 * │     request, so access to a document ends when ownership does.           │
 * │  2. CONTENT-DISPOSITION. The bytes came off a stranger's disk. They are  │
 * │     served `attachment`, always, so a browser saves them instead of      │
 * │     rendering them — see the note on that header below.                  │
 * │  3. CSP. Reads stay same-origin, so `connect-src` never has to name the  │
 * │     blob store. See src/lib/security-headers.ts.                         │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * The alternative — minting a short-lived signed blob URL per request — was
 * rejected because it re-introduces (1) for the lifetime of the signature and
 * gives up (2) and (3) entirely, in exchange for saving a proxy hop on a file
 * capped at 25 MB.
 */

/** The Blob SDK needs Node APIs; this cannot run on the Edge runtime. */
export const runtime = "nodejs";

/** A session-scoped read. Nothing here is cacheable by anyone. */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ documentId: string }> },
): Promise<Response> {
  /*
   * NOT `requireDocumentAccess`. That helper is written for pages and Server
   * Actions: it `redirect()`s an anonymous caller to /sign-in and `notFound()`s
   * a missing document, which renders HTML. A `fetch` for a PDF wants a status
   * code, so the same two checks are made here and answered with 401 and 404.
   *
   * The 404 is deliberately indistinguishable between "no such document",
   * "someone else's document", and "deleted" — the same rule the rest of the
   * application follows.
   */
  const user = await getUser();
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { documentId } = await context.params;
  if (!UUID.test(documentId)) {
    return new Response("Not found", { status: 404 });
  }

  const [document] = await db
    .select({
      blobUrl: documents.blobUrl,
      filename: documents.filename,
      mimeType: documents.mimeType,
    })
    .from(documents)
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.userId, user.id),
        isNull(documents.deletedAt),
      ),
    )
    .limit(1);

  if (!document) {
    return new Response("Not found", { status: 404 });
  }

  /*
   * A MISSING OBJECT IS A 404, NOT A 500.
   *
   * It is the ordinary state for a demo document seeded from committed text,
   * which never had a blob at all — `blob_url` there is a deliberately
   * non-resolving `.invalid` URL. The row is real and the reader owns it; the
   * bytes simply are not there, and that is exactly what "not found" means.
   */
  let stored;
  try {
    stored = await readDocumentBlob(document.blobUrl);
  } catch (error) {
    console.error("[documents] blob read failed", documentId, error);
    stored = null;
  }

  if (!stored) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(stored.stream, {
    status: 200,
    headers: responseHeaders(document.mimeType, document.filename),
  });
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The headers that make serving somebody else's file safe.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * CONTENT-DISPOSITION IS `attachment`, WITH NO EXCEPTION FOR PDF
 *
 * `inline` asks the browser to render the file in a top-level document at THIS
 * origin. For a PDF that means the built-in viewer, which executes the file's
 * JavaScript actions; for anything a browser decides to treat as markup it
 * means script running as us, with our cookies. The content type is verified at
 * upload and the bytes are sniffed at extraction, so neither is likely — but
 * `attachment` makes it structurally impossible rather than merely unlikely,
 * and it costs nothing here.
 *
 * It costs nothing because NOTHING IN THIS APPLICATION NEEDS `inline`. PDF.js
 * fetches these bytes with `fetch` and rasterises them onto a canvas itself; a
 * response body is a response body to it, and Content-Disposition is not
 * consulted. The toolbar's download link is an `<a download>` on a same-origin
 * URL, which saves the file whatever this header says. So `attachment` is the
 * strictly safer value with no behaviour to trade for it.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE CONTENT TYPE IS THE VERIFIED ONE, NOT THE STORED OBJECT'S
 *
 * `documents.mime_type` was written from a `head()` on the stored object and
 * checked against the upload allowlist, and the bytes were separately sniffed
 * at extraction. Echoing whatever the store reports today would re-open that
 * decision on every request. The allowlist is re-applied anyway, so a row
 * carrying an unexpected type serves as `application/octet-stream` rather than
 * as anything a browser has an opinion about.
 *
 * `X-Content-Type-Options: nosniff` is already set globally in next.config.ts;
 * it is repeated here because it is what turns the line above into a guarantee,
 * and a reader of this file should not have to go and check.
 */
function responseHeaders(mimeType: string, filename: string): Headers {
  const type = ACCEPTED_CONTENT_TYPES.includes(mimeType)
    ? mimeType
    : "application/octet-stream";

  return new Headers({
    "content-type": type,
    "content-disposition": `attachment; filename="${asciiFilename(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "x-content-type-options": "nosniff",
    // A private document behind a session. No shared cache may hold it, and no
    // browser should serve it back after the session ends.
    "cache-control": "private, no-store, max-age=0",
    // Range requests are not served, and saying so stops PDF.js from trying.
    "accept-ranges": "none",
  });
}

/**
 * The `filename` fallback for clients that do not read RFC 5987.
 *
 * Quotes, backslashes, and control characters are removed rather than escaped:
 * a quote closes the parameter early and lets the rest of the filename be read
 * as further header parameters, which is header injection with extra steps. The
 * `filename*` parameter beside it carries the real name, so this one only has
 * to be safe, not faithful.
 */
function asciiFilename(filename: string): string {
  const cleaned = filename
    .replace(/[\u0000-\u001F\u007F"\\]/g, "")
    .replace(/[^\x20-\x7E]/g, "_")
    .slice(0, 120)
    .trim();
  return cleaned || "document";
}
