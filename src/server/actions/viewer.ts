"use server";

import { z } from "zod";

import { requireDocumentAccess } from "@/lib/auth-server";
import { loadPageText } from "@/lib/document-view";
import {
  MAX_MATCHES,
  MIN_QUERY_LENGTH,
  searchPages,
  type DocumentMatch,
} from "@/lib/viewer/search";

/**
 * IN-DOCUMENT SEARCH, ON THE SERVER.
 *
 * A Server Action rather than a route handler for the same reason the document
 * progress poll is one: `requireDocumentAccess` is the ownership boundary the
 * rest of the application already uses, and it 404s identically whether the
 * document is missing or belongs to somebody else. A hand-rolled fetch would
 * have to re-establish that, and would be the one place it could be forgotten.
 *
 * It runs over `document_pages.text` — the text extracted at ingestion — which
 * is the only way a search can cover pages the virtualiser has not rendered.
 * The browser's own Ctrl+F sees a handful of pages; this sees all three
 * hundred. That is why the viewer takes Cmd+F over rather than leaving it.
 */

export type ActionResult<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

const searchSchema = z.object({
  documentId: z.uuid(),
  // Bounded because it arrives from the network. A query longer than this is
  // not a search anyone typed.
  query: z.string().trim().min(MIN_QUERY_LENGTH).max(200),
});

export async function searchDocument(
  documentId: string,
  query: string,
): Promise<
  ActionResult<{
    matches: DocumentMatch[];
    /** True when the cap was hit — the UI says so rather than lying by omission. */
    truncated: boolean;
  }>
> {
  const parsed = searchSchema.safeParse({ documentId, query });
  if (!parsed.success) {
    // A query below the minimum is not an error, it is "not searching yet".
    return { ok: true, matches: [], truncated: false };
  }

  const { document } = await requireDocumentAccess(parsed.data.documentId);

  if (document.status !== "ready") {
    return {
      ok: false,
      error: "This document is still being processed, so it cannot be searched yet.",
    };
  }

  const pages = await loadPageText(document.id);
  const { matches, truncated } = searchPages(pages, parsed.data.query, MAX_MATCHES);

  return { ok: true, matches, truncated };
}
