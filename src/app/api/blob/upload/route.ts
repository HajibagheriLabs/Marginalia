/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ WHY THIS ROUTE EXISTS, AND WHY THE FILE BYTES DO NOT COME THROUGH IT.    │
 * │                                                                          │
 * │ A Vercel Serverless Function has a HARD 4.5 MB REQUEST BODY LIMIT. It is │
 * │ a platform limit, not a config value: there is no plan, no header, and   │
 * │ no `bodyParser` setting that raises it. A 20 MB contract POSTed to a     │
 * │ Next.js route handler is rejected by the platform with a 413 before a    │
 * │ single line of application code runs — you cannot catch it, log it, or   │
 * │ turn it into a good error message. And the payload is base64-inflated on │
 * │ the way in, so the real ceiling is nearer 3 MB of actual file.           │
 * │                                                                          │
 * │ So the bytes never touch a function. They go BROWSER → VERCEL BLOB,      │
 * │ directly. What this route hands out is permission:                       │
 * │                                                                          │
 * │   1. The browser asks this route for a token, naming the pathname, the   │
 * │      content type, and the size it intends to upload.                    │
 * │   2. This route checks the session, checks that the pathname belongs to  │
 * │      that user, and checks the per-user document quota.                  │
 * │   3. It mints a SHORT-LIVED token that encodes the constraints — the     │
 * │      allowed content types and the maximum size. The store enforces      │
 * │      them; they are not advisory.                                        │
 * │   4. The browser uploads to Blob with that token and reports progress.   │
 * │   5. On completion the client calls a Server Action, which re-reads the  │
 * │      stored blob's real content type and size with `head()` and only     │
 * │      then writes the `documents` row.                                    │
 * │                                                                          │
 * │ The indirection buys three things at once: uploads unbounded by the      │
 * │ function body limit, no function compute burned streaming bytes, and an  │
 * │ authorization check that still happens on the server before any write.   │
 * │                                                                          │
 * │ NOTE on `onUploadCompleted`: @vercel/blob can call back into the app     │
 * │ when an upload finishes, but that callback is an inbound HTTP request    │
 * │ from Vercel's infrastructure and it CANNOT reach http://localhost. Using │
 * │ it as the only way rows get created would mean uploads that work in      │
 * │ production and silently do nothing in development. The Server Action in  │
 * │ src/server/actions/documents.ts is the single source of truth instead —  │
 * │ it works identically in both places, and it verifies the stored object   │
 * │ rather than trusting a callback payload.                                 │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT THIS ROUTE ENFORCES, AND WHAT IT ONLY PRE-CHECKS
 *
 * ENFORCED here, because nothing later can: the token's content-type
 * allowlist and `maximumSizeInBytes`. Those constraints are signed into the
 * token and applied by the STORE, so a client that lies about either has its
 * transfer rejected at the destination.
 *
 * PRE-CHECKED here, and decided elsewhere: the document count. Two token
 * requests can pass this check concurrently, which is precisely why the real
 * enforcement is a count-and-insert in one transaction under a per-user
 * advisory lock — see `insertDocumentWithinLimit`. The check here exists so a
 * user at the ceiling learns it before spending 25 MB of their uplink, not
 * after.
 *
 * RATE LIMITED here: a token bucket per user. A token is a bearer credential
 * that authorises writes into the store, and handing out an unbounded number
 * of them is worth stopping regardless of what the user does with them.
 */
import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";

import { getUser } from "@/lib/auth-server";
import { DEMO_BANNER, isDemoUser } from "@/lib/demo";
import { env } from "@/lib/env";
import {
  LIMITS,
  documentLimitNotice,
  pageLimitNotice,
  rateLimitNotice,
  type LimitNotice,
} from "@/lib/limits";
import { release, take } from "@/lib/rate-limit";
import { countUserDocuments, countUserPages } from "@/lib/usage";
import {
  ACCEPTED_CONTENT_TYPES,
  MAX_UPLOAD_BYTES,
  isOwnedBlobPathname,
} from "@/lib/upload";

/** Local embeddings and the Blob SDK both need Node APIs. Never the Edge runtime. */
export const runtime = "nodejs";

/**
 * How long a minted token stays usable.
 *
 * Short, because it is a bearer credential that authorises writes into the
 * store — but not so short that a 25 MB upload on a bad connection outlives it
 * mid-flight. Ten minutes covers 25 MB at roughly 350 kbit/s.
 */
const TOKEN_LIFETIME_MS = 10 * 60 * 1000;

/**
 * A refusal whose message was written FOR the user.
 *
 * Errors thrown inside `onBeforeGenerateToken` surface through `handleUpload`
 * mixed in with SDK and network failures, and those must not have their text
 * echoed to the browser — an internal message is at best confusing and at worst
 * leaks something. This class is the marker for "this sentence is meant to be
 * read"; everything else becomes a generic message and a server-side log.
 *
 * It carries the `LimitNotice` when the refusal is a limit, so the browser can
 * open the dialog that names the ceiling instead of showing a toast.
 */
class UploadRefused extends Error {
  readonly notice?: LimitNotice;

  constructor(message: string, notice?: LimitNotice) {
    super(message);
    this.notice = notice;
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json()) as HandleUploadBody;

  // Authentication happens HERE, not in the proxy. src/proxy.ts only checks
  // that a session cookie is present; this reads the session.
  const user = await getUser();
  if (!user) {
    return NextResponse.json(
      { error: "Sign in to upload documents." },
      { status: 401 },
    );
  }

  /*
   * THE DEMO ACCOUNT CANNOT UPLOAD, and this is where that is decided.
   *
   * Not in the UI. The dropzone hides itself for the demo, but a Server Action
   * and a route handler are public HTTP endpoints with generated names, and a
   * hidden button is not a restriction. The account is shared, so one visitor's
   * upload would sit in every later visitor's library, backed by blob storage
   * and vector points nobody is going to clean up.
   */
  if (isDemoUser(user.id)) {
    return NextResponse.json({ error: DEMO_BANNER.title }, { status: 403 });
  }

  // Per-user throttle, before any database work. Keyed by user rather than by
  // address: a token is minted against an account, and two people behind one
  // office NAT are not each other's problem.
  const rate = take("upload", user.id);
  if (!rate.ok) {
    const notice = rateLimitNotice("uploads", rate.resetAt);
    return NextResponse.json(
      { error: notice.message, limit: notice },
      {
        status: 429,
        headers: {
          "retry-after": String(
            Math.max(1, Math.ceil((rate.resetAt.getTime() - Date.now()) / 1000)),
          ),
        },
      },
    );
  }

  try {
    const result = await handleUpload({
      request,
      body,
      token: env.BLOB_READ_WRITE_TOKEN,

      onBeforeGenerateToken: async (pathname) => {
        // The CLIENT chooses the pathname — that is how client uploads work,
        // since the pathname is signed into the token. So it is re-derived and
        // checked here; a token for someone else's prefix is never minted.
        if (!isOwnedBlobPathname(pathname, user.id)) {
          throw new UploadRefused(
            "That upload path is not valid for this account.",
          );
        }

        const [documents, pages] = await Promise.all([
          countUserDocuments(user.id),
          countUserPages(user.id),
        ]);

        if (documents >= LIMITS.documents) {
          const notice = documentLimitNotice(documents);
          throw new UploadRefused(`${notice.message} ${notice.nextStep}`, notice);
        }

        // The page ceiling cannot be checked properly until the file has been
        // parsed — a 25 MB PDF may hold 40 pages or 4,000 — so extraction is
        // where it is decided. What CAN be answered now is whether there is
        // any room at all, and refusing an upload that could not possibly fit
        // is better than accepting it and failing it four stages later.
        if (pages >= LIMITS.totalPages) {
          const notice = pageLimitNotice(pages, 1);
          throw new UploadRefused(`${notice.message} ${notice.nextStep}`, notice);
        }

        return {
          // Enforced by the store, not by us. A client that lies about its
          // content type or its size has its upload rejected at the store.
          allowedContentTypes: ACCEPTED_CONTENT_TYPES,
          maximumSizeInBytes: MAX_UPLOAD_BYTES,
          validUntil: Date.now() + TOKEN_LIFETIME_MS,
          // Two files named "contract.pdf" are two documents, not one
          // overwriting the other. The suffix also makes the stored URL
          // unguessable, and overwrite is refused outright.
          addRandomSuffix: true,
          allowOverwrite: false,
          tokenPayload: JSON.stringify({ userId: user.id }),
        };
      },
    });

    return NextResponse.json(result);
  } catch (error) {
    // A refusal did no work, so the bucket token it spent is given back.
    // Otherwise a user at the document ceiling would burn their whole upload
    // allowance discovering it.
    //
    // NOTE ON WHERE THIS BODY GOES: @vercel/blob's client `upload()` does not
    // surface a non-2xx body from this route — it throws "Failed to retrieve
    // the client token" and discards the response. So the `limit` payload here
    // is for logs and for any caller that talks to this route directly; the
    // BROWSER learns about a limit from `checkUploadAllowance` before the
    // upload starts, and from `registerUploadedDocument` after it finishes.
    // Both are Server Actions, and both return the same `LimitNotice` shape.
    if (error instanceof UploadRefused) {
      release("upload", user.id);
      return NextResponse.json(
        { error: error.message, limit: error.notice ?? null },
        { status: error.notice ? 409 : 400 },
      );
    }

    console.error("[upload] token request failed", error);
    return NextResponse.json(
      { error: "The upload failed. Try again." },
      { status: 400 },
    );
  }
}
