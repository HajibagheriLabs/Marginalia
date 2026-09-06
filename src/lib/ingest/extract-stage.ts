import { and, eq, isNull } from "drizzle-orm";
import { get } from "@vercel/blob";

import { db } from "@/db";
import { documentPages, documents } from "@/db/schema";
import { env } from "@/lib/env";
import { LimitError, assertPageAllowance } from "@/lib/usage";

import { ExtractionError, extractDocument } from "./extract";
import { StageError, type StageResult, type StageDeps } from "./stage";

/**
 * The extraction STAGE: everything around `extract.ts` that touches the world.
 *
 * Split from the extractor itself so that the parsing, normalization, and
 * offset arithmetic can be unit-tested against real files without a Postgres
 * connection or a Blob token. This file has the side effects; that one has the
 * logic.
 *
 * IDEMPOTENT, like every stage in the ingestion state machine. Re-running it on
 * a document that has already been extracted deletes that document's pages and
 * writes them again, inside one transaction, so a retry after a partial failure
 * cannot leave a half-extracted document behind. That property is what lets the
 * "Retry" action in the UI simply call this again, and what will let a queue
 * deliver the same job twice without corrupting anything.
 *
 *   uploaded → EXTRACTING → chunking → embedding → indexing → ready | failed
 *
 * It does NOT write `documents.status` and does not decide what runs next —
 * see the stage contract in `stage.ts`. It does the work, or it throws a
 * `StageError` carrying a message fit to show the person who uploaded the file.
 * The orchestrator owns the state machine.
 */

/**
 * Read every byte of a blob into memory.
 *
 * The whole file is needed at once: PDF.js parses the cross-reference table at
 * the END of a PDF before it can read any page, so there is no useful streaming
 * path here. The 25 MB upload cap is what keeps this safe — it is also, not
 * coincidentally, what keeps the stage inside the memory a Vercel function has.
 */
async function readBlob(url: string): Promise<Uint8Array> {
  const result = await get(url, {
    // The store is configured for private access, so a blob is not readable
    // from its URL alone. Reads are authenticated with the read-write token.
    access: "private",
    token: env.BLOB_READ_WRITE_TOKEN,
  });
  if (!result || result.statusCode !== 200) {
    throw new ExtractionError(
      "corrupt",
      "The stored file could not be read back. Upload it again.",
    );
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = result.stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/**
 * Extract one document's text and persist its pages.
 *
 * `userId` is required and applied as a predicate even though this runs as a
 * background job rather than a request: `documents` is a user-owned table, and
 * the rule that every query against one carries a `user_id` predicate does not
 * get an exception for code that happens to trust itself.
 */
export async function runExtraction(
  documentId: string,
  userId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _deps?: StageDeps,
): Promise<StageResult> {
  const [document] = await db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.userId, userId),
        isNull(documents.deletedAt),
      ),
    )
    .limit(1);

  if (!document) {
    throw new StageError("That document no longer exists.");
  }

  let result;
  try {
    const data = await readBlob(document.blobUrl);
    result = await extractDocument({
      data,
      filename: document.filename,
      mimeType: document.mimeType,
      // No OCR provider is wired up. A scanned PDF is refused with a message
      // that says so — see the OCR SEAM comment in extract.ts.
    });
  } catch (error) {
    // An ExtractionError carries a message written for the person who uploaded
    // the file. Anything else is a bug, and its text must not be shown — the
    // orchestrator substitutes a generic one for anything that is not a
    // StageError.
    if (error instanceof ExtractionError) {
      throw new StageError(error.message, { cause: error });
    }
    throw error;
  }

  try {
    await db.transaction(async (tx) => {
      // IDEMPOTENCE: a re-run replaces the previous extraction wholesale rather
      // than appending to it. Everything keyed to the old pages is downstream of
      // this stage and is rebuilt by the stages that follow.
      await tx
        .delete(documentPages)
        .where(eq(documentPages.documentId, document.id));

      /*
       * THE PAGE LIMIT IS DECIDED HERE.
       *
       * This is the first moment the number is knowable: a 25 MB PDF may hold
       * 40 pages or 4,000, and nothing in the upload request distinguishes
       * them. Checking earlier would mean guessing, and a guessed ceiling
       * either blocks valid uploads or fails to block the ones that matter.
       *
       * It runs INSIDE this transaction, AFTER the delete above, and under a
       * per-user advisory lock. The ordering is what makes a retry free — this
       * document's own previous pages are already out of the count, so
       * re-extracting a 400-page file measures it once rather than twice — and
       * the lock is what stops two documents extracting concurrently from both
       * passing a check that only one of them fits through.
       *
       * A refusal rolls back this whole transaction, so a document that does
       * not fit leaves no pages behind. It surfaces as a failed document with
       * a "Retry" action, which is exactly right: the file is intact in the
       * store, and deleting something else makes the retry succeed.
       */
      await assertPageAllowance(tx, userId, result.pages.length);

      await tx.insert(documentPages).values(
        result.pages.map((page) => ({
          documentId: document.id,
          pageNumber: page.pageNumber,
          text: page.text,
          charStart: page.charStart,
          charEnd: page.charEnd,
        })),
      );

      await tx
        .update(documents)
        .set({ pageCount: result.pageCount })
        .where(eq(documents.id, document.id));
    });
  } catch (error) {
    // A limit is not a bug, and its sentence was written for the person who
    // uploaded the file — it names the ceiling, the current usage, and the way
    // out. Re-thrown as a StageError so the orchestrator records it as the
    // document's error message and surfaces the "Retry" action beside it.
    if (error instanceof LimitError) {
      throw new StageError(`${error.notice.message} ${error.notice.nextStep}`, {
        cause: error,
      });
    }
    throw error;
  }

  return {
    complete: true,
    detail: `${result.pageCount} pages, ${result.text.length} chars${
      result.ocrUsed ? ", OCR" : ""
    }`,
  };
}
