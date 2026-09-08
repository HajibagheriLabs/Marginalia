import { get } from "@vercel/blob";

import { env } from "./env";

/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ READING A DOCUMENT'S BYTES BACK OUT OF STORAGE. ONE PLACE.               │
 * │                                                                          │
 * │ Two callers need this and they used to have two copies of it: the        │
 * │ extraction stage, which parses the file, and the document file route,    │
 * │ which streams it to the browser. Both take a `documents.blob_url` and    │
 * │ both have to present the read-write token, because the store is          │
 * │ configured for PRIVATE access and a blob is not readable from its URL    │
 * │ alone.                                                                   │
 * │                                                                          │
 * │ THE ACCESS RULE IS THE REASON THIS IS SHARED. `access: "private"` and    │
 * │ the token are not options a call site chooses; they are what makes a     │
 * │ read work at all, and a caller that forgets them gets a 404 that reads   │
 * │ like a missing file. Two copies of a rule is one copy that eventually    │
 * │ drifts, and the drift here is invisible until a document will not open.  │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

/** What a caller needs, and nothing more: the bytes, as a stream. */
export interface BlobRead {
  stream: ReadableStream<Uint8Array>;
}

/**
 * Read one document's stored file, or null if it is not there.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE FIXTURE ORIGIN, AND WHY IT IS AN OVERRIDE RATHER THAN A TEST BRANCH
 *
 * `BLOB_FIXTURE_ORIGIN` is normally unset and this function is exactly
 * `get(url, { access: "private", token })`.
 *
 * The end-to-end suite needs somewhere for a real PDF to live that is not
 * Vercel Blob: CI has no Blob token and should not need one, and the browser
 * has to be able to fetch the file through this application in order to render
 * it. So the suite serves the fixture from a local HTTP server and points this
 * variable at that server's origin.
 *
 * It follows the same rule as `OPENROUTER_BASE_URL`: an operator-configured
 * OVERRIDE, not an `if (isTest)`. Nothing about the route, the ownership check,
 * the headers, or the viewer changes — the E2E suite exercises the shipping
 * code path, against a production build, and the only thing that differs is
 * which socket the bytes come from.
 *
 * IT IS NOT AN SSRF HOLE, and the shape is what makes that true rather than
 * the intent. The URL comes from `documents.blob_url`, which is written only
 * from a verified Blob object, and the origin is compared against a value the
 * OPERATOR set — not against anything a request can influence. With the
 * variable unset, which is every real deployment, no URL can take this branch.
 */
export async function readDocumentBlob(url: string): Promise<BlobRead | null> {
  const fixtureOrigin = env.BLOB_FIXTURE_ORIGIN;
  if (fixtureOrigin && isWithinOrigin(url, fixtureOrigin)) {
    const response = await fetch(url);
    if (!response.ok || !response.body) return null;
    return { stream: response.body };
  }

  const result = await get(url, {
    access: "private",
    token: env.BLOB_READ_WRITE_TOKEN,
  });

  if (!result || result.statusCode !== 200) return null;
  return { stream: result.stream };
}

/**
 * Is this URL served by the configured origin?
 *
 * Parsed rather than compared as a prefix. `startsWith` would accept
 * `http://127.0.0.1:3102.example.com/x` for the origin `http://127.0.0.1:3102`,
 * which is the classic way an origin check becomes an open redirect — and the
 * cost of doing it properly is one `URL` constructor.
 */
function isWithinOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

/** Every byte of a blob, in memory. */
export async function readDocumentBlobBytes(
  url: string,
): Promise<Uint8Array | null> {
  const blob = await readDocumentBlob(url);
  if (!blob) return null;

  const parts: Uint8Array[] = [];
  let total = 0;

  const reader = blob.stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.length;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
