import type { RetrievedPassage } from "@/lib/retrieval";

/**
 * CONTEXT ASSEMBLY — rendering retrieved passages for the model.
 *
 * Each passage gets a header naming where it came from, then its text:
 *
 *     [3] Master Services Agreement — Article 7 › 7.3 Termination · pages 14-15
 *     Either party may terminate this agreement for convenience by giving
 *     thirty (30) days prior written notice to the other party.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THE HEADER IS THERE
 *
 * Not decoration, and not for the user — the user never sees this string. It
 * does three things the bare text cannot:
 *
 *   1. It makes the marker unambiguous. The number has to be adjacent to the
 *      text it labels, or the model has to hold a separate mapping in its head
 *      while writing, which is exactly where off-by-one citations come from.
 *
 *   2. It lets the model reason about PROVENANCE. Asked "does the contract or
 *      the policy say this?", a model given bare passages can only guess.
 *      Given titles it can answer, and can say "the agreement says X [1] while
 *      the policy says Y [4]" — which is most of the value of searching more
 *      than one document at a time.
 *
 *   3. The section path carries structure the passage text lost. "Thirty days
 *      notice" means something different under "Termination for convenience"
 *      than under "Force majeure", and the chunk itself may not say which it
 *      is under.
 *
 * The same reasoning as the ingest-time context header on embeddings — the
 * surrounding structure is known for free and is exactly what the passage is
 * missing.
 */

export const CONTEXT = {
  /**
   * How a page range reads for a document with SYNTHETIC page boundaries.
   *
   * A DOCX or a Markdown file has no pages; the paginator invented those
   * boundaries. Calling them "pages" to the model invites it to write "see page
   * 4 of the policy" in an answer, which is a precision the source does not
   * have and which the user cannot verify by opening the file. Not currently
   * threaded through — `RetrievedPassage` does not carry the boundary kind —
   * and noted here as the reason to add it rather than as an oversight.
   */
  syntheticPageLabel: "block",
} as const;

/** The separator between passages. A blank line and a rule, so blocks are unmistakable. */
const PASSAGE_SEPARATOR = "\n\n";

function formatPages(pageFrom: number, pageTo: number): string {
  return pageFrom === pageTo ? `page ${pageFrom}` : `pages ${pageFrom}-${pageTo}`;
}

/**
 * One passage, with its provenance header.
 *
 * The header is a single line so it cannot be mistaken for content, and the
 * marker leads it so the number is the first thing on the line — the model
 * scans for `[3]` when it decides what to cite, and it should find it at a
 * predictable position rather than inside prose.
 */
export function formatPassage(passage: RetrievedPassage): string {
  const parts = [passage.documentTitle];
  if (passage.sectionPath) parts.push(passage.sectionPath);

  const header = `[${passage.marker}] ${parts.join(" — ")} · ${formatPages(
    passage.pageFrom,
    passage.pageTo,
  )}`;

  return `${header}\n${passage.text}`;
}

/**
 * The full context block handed to the model.
 *
 * Passages appear in RELEVANCE order, which is the order retrieval assigned the
 * markers. Not document order: the most relevant passage should be the one the
 * model reads first, and renumbering into document order would either break the
 * marker sequence or bury the best passage in the middle.
 */
export function buildContext(passages: RetrievedPassage[]): string {
  return passages.map(formatPassage).join(PASSAGE_SEPARATOR);
}

/**
 * The user turn: the context, then the question.
 *
 * QUESTION LAST, deliberately. Models attend most reliably to the beginning and
 * the end of a prompt, and of the two the question is what the whole response
 * hangs on — putting it after the passages means the last thing read before
 * generating is what was actually asked. It also keeps the passages contiguous
 * with the system prompt's rules about them.
 */
export function buildUserPrompt(
  passages: RetrievedPassage[],
  question: string,
): string {
  return [
    "PASSAGES",
    "",
    buildContext(passages),
    "",
    "QUESTION",
    "",
    question,
  ].join("\n");
}
