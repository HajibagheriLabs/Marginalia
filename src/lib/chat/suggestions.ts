import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import { chunks, documents } from "@/db/schema";

/**
 * THE THREE EXAMPLE QUESTIONS IN THE EMPTY STATE.
 *
 * They are derived from the documents that are ACTUALLY SELECTED, not written
 * in advance, because a generic example is worse than none: "What are the
 * payment terms?" shown above a clinical guideline teaches the reader that the
 * suggestions are decoration and that this tool does not know what it is
 * holding.
 *
 * The source is the heading breadcrumb stored on every chunk during ingestion —
 * `section_path`, e.g. "7. Termination › 7.2 For convenience". That column is
 * the document's own table of contents, already extracted, already indexed.
 * Deriving a question from it costs one indexed query and produces a question
 * that is guaranteed to have a passage behind it.
 *
 * NO MODEL IS CALLED. Same reasoning as the conversation title: the free pool
 * is a shared ~200 requests per day, and spending three of them to rephrase
 * headings the ingester already parsed would be paying an answer's worth of
 * quota for placeholder text.
 */

/** Three is the specified count; the query asks for more so it can filter. */
const SUGGESTION_COUNT = 3;
/**
 * Headings read before giving up. Generous, because most are rejected: the
 * filters below drop numbering-only headings, structural furniture, and
 * anything too short to name a subject.
 */
const CANDIDATE_LIMIT = 200;
/** Kept per document, so one heavily sectioned document cannot crowd out the rest. */
const PER_DOCUMENT_LIMIT = 4;

/** Leading numbering: "7.2 ", "Article IV. ", "(a) ". Noise inside a question. */
const NUMBERING = /^(?:\(?[0-9ivxlcIVXLC]+[.):]\s*)+/;

/**
 * A heading is only useful if it names a subject. These do not — they are
 * structural furniture that appears in almost every long document, and a
 * question about "Appendix A" is not a question.
 */
const UNINFORMATIVE = new Set([
  "introduction",
  "background",
  "overview",
  "contents",
  "table of contents",
  "index",
  "appendix",
  "appendices",
  "annex",
  "schedule",
  "exhibit",
  "preamble",
  "recitals",
  "definitions",
  "general",
  "miscellaneous",
  "notes",
  "references",
  "bibliography",
  "abstract",
  "summary",
  "conclusion",
  "acknowledgements",
  "acknowledgments",
]);

/** The last segment of a breadcrumb is the most specific heading in it. */
function leafHeading(sectionPath: string): string | null {
  const leaf = sectionPath.split("›").pop()?.trim() ?? "";
  const cleaned = leaf.replace(NUMBERING, "").replace(/\s+/g, " ").trim();

  if (cleaned.length < 4 || cleaned.length > 60) return null;
  if (UNINFORMATIVE.has(cleaned.toLowerCase())) return null;
  // A heading that is only digits or punctuation carries no subject.
  if (!/[a-z]/i.test(cleaned)) return null;

  return cleaned;
}

/**
 * Headings are often Title Case or ALL CAPS; a question is neither.
 *
 * Words carrying two or more capitals or digits are left exactly as written —
 * defined terms, party names, and part numbers like ZX-4471-Q are quoted
 * verbatim or not at all, since lowercasing one changes what was asked.
 */
function toSubject(heading: string): string {
  const shouted = heading === heading.toUpperCase();

  return heading
    .split(" ")
    .map((word) => {
      if (/[A-Z0-9].*[A-Z0-9]/.test(word)) return shouted ? word.toLowerCase() : word;
      return word.toLowerCase();
    })
    .join(" ");
}

export interface Suggestion {
  question: string;
  documentId: string;
}

/**
 * Up to three example questions for a set of selected documents.
 *
 * Spread ACROSS the documents rather than taken from the best-covered one:
 * when three documents are selected, three questions from the first would
 * suggest the other two are not being searched.
 */
export async function suggestQuestions(
  userId: string,
  documentIds: string[],
): Promise<Suggestion[]> {
  if (documentIds.length === 0) return [];

  // Ownership is re-established here rather than assumed from the caller: this
  // runs behind a Server Action, so `documentIds` arrived over the network.
  const owned = await db
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(
      and(
        inArray(documents.id, documentIds),
        eq(documents.userId, userId),
        isNull(documents.deletedAt),
        eq(documents.status, "ready"),
      ),
    );

  if (owned.length === 0) return [];
  const titles = new Map(owned.map((row) => [row.id, row.title]));

  const rows = await db
    .selectDistinctOn([chunks.documentId, chunks.sectionPath], {
      documentId: chunks.documentId,
      sectionPath: chunks.sectionPath,
      ordinal: chunks.ordinal,
    })
    .from(chunks)
    .where(
      and(
        inArray(chunks.documentId, [...titles.keys()]),
        sql`${chunks.sectionPath} is not null`,
      ),
    )
    .orderBy(asc(chunks.documentId), asc(chunks.sectionPath), asc(chunks.ordinal))
    .limit(CANDIDATE_LIMIT);

  // Group by document, preserving document order, so the round-robin below can
  // take one from each in turn.
  const byDocument = new Map<string, string[]>();
  for (const row of rows) {
    const heading = row.sectionPath ? leafHeading(row.sectionPath) : null;
    if (!heading) continue;
    const list = byDocument.get(row.documentId) ?? [];
    if (list.length < PER_DOCUMENT_LIMIT && !list.includes(heading)) {
      list.push(heading);
    }
    byDocument.set(row.documentId, list);
  }

  const suggestions: Suggestion[] = [];
  const single = titles.size === 1;

  // Round-robin over the selected documents until three questions exist.
  for (let round = 0; suggestions.length < SUGGESTION_COUNT && round < 4; round += 1) {
    for (const documentId of titles.keys()) {
      if (suggestions.length >= SUGGESTION_COUNT) break;
      const heading = byDocument.get(documentId)?.[round];
      if (!heading) continue;

      const subject = toSubject(heading);
      suggestions.push({
        documentId,
        // Naming the document is only useful when there is more than one; with
        // a single document selected it is in the header two lines above.
        question: single
          ? `What does this document say about ${subject}?`
          : `What does ${titles.get(documentId)} say about ${subject}?`,
      });
    }
  }

  if (suggestions.length > 0) return suggestions;

  /* ── FALLBACK ────────────────────────────────────────────────────────────
   * A document with no headings at all — a scanned report, a plain-text
   * export. There is nothing to derive a subject from, so the questions are
   * about the document as a whole rather than invented topics inside it.
   */
  return owned.slice(0, SUGGESTION_COUNT).map((row, index) => ({
    documentId: row.id,
    question: [
      `What is ${row.title} about?`,
      `What are the main obligations in ${row.title}?`,
      `What dates or deadlines does ${row.title} set?`,
    ][index],
  }));
}
