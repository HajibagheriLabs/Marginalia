/**
 * IN-DOCUMENT SEARCH.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * IT RUNS OVER THE TEXT ALREADY IN POSTGRES
 *
 * `document_pages.text` was extracted once, at ingestion, and it is the same
 * text the chunker measured its offsets against. Searching it — rather than
 * re-extracting in the browser — buys three things:
 *
 *   - IT COVERS THE WHOLE DOCUMENT. The viewer renders a handful of pages at a
 *     time; pages 40 through 300 have no DOM. A browser-side search, including
 *     the browser's own Ctrl+F, can only ever find what is currently rendered,
 *     which for a virtualised viewer is a search that lies.
 *   - IT AGREES WITH RETRIEVAL. Matches are found in exactly the characters a
 *     citation's `char_start`/`char_end` index into, so "search found it on
 *     page 14" and "the answer cited page 14" cannot disagree.
 *   - IT COSTS NOTHING TO START. No second parse of a 25 MB PDF in the tab
 *     that is already rasterising it.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHITESPACE IS FLEXIBLE, EVERYTHING ELSE IS LITERAL
 *
 * Extracted PDF text keeps its line structure — deliberately, because
 * reflowing it would make the stored text unrecognisable against what PDF.js
 * reports at render time and break citation highlighting. The consequence is
 * that "termination notice" is stored as "termination\nnotice" whenever the
 * phrase straddles a line, which is most of the time in a two-column contract.
 *
 * So a run of whitespace in the query matches a run of whitespace in the text.
 * Nothing else is interpreted: the query is escaped, so a reader searching for
 * "(a)" or "$1,000.00" or "s.7(2)" finds those characters and not a regex.
 */

/** One match, as an offset into the page text it was found in. */
export interface TextMatch {
  /** Offset into the page's own text, not the document's. */
  start: number;
  /** Length in characters of the matched span, which may exceed the query. */
  length: number;
}

/** A match located in the document, with the page that holds it. */
export interface DocumentMatch extends TextMatch {
  /** 1-based. Physical page for PDFs, synthetic block otherwise. */
  pageNumber: number;
}

/**
 * Shorter than this and a search is not a search.
 *
 * One character matches a meaningful fraction of any document — tens of
 * thousands of hits on a long contract, none of which help. Two is the point
 * where a query starts to mean something ("7.", "SO", "£5").
 */
export const MIN_QUERY_LENGTH = 2;

/**
 * A ceiling on matches returned for one query.
 *
 * A search for "the" in a 300-page contract has thousands of hits, and no
 * reader is stepping through them. The cap keeps the payload and the
 * navigation honest; the UI says the count was capped rather than reporting a
 * number it quietly truncated.
 */
export const MAX_MATCHES = 500;

/** Escape a user string so it is matched as characters, never as a pattern. */
function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a query into a matcher.
 *
 * Returns null for a query too short to be useful, so every caller handles the
 * "not searching yet" state the same way instead of each inventing a rule.
 */
export function compileQuery(query: string): RegExp | null {
  const trimmed = query.trim();
  if (trimmed.length < MIN_QUERY_LENGTH) return null;

  // Each whitespace run becomes "one or more whitespace characters", which is
  // what lets a phrase match across the line break the PDF put in the middle
  // of it. Everything else is escaped to a literal.
  const pattern = trimmed
    .split(/\s+/)
    .map(escapeLiteral)
    .join("\\s+");

  return new RegExp(pattern, "giu");
}

/** Every match of a compiled query within one page's text. */
export function findMatches(text: string, matcher: RegExp): TextMatch[] {
  const matches: TextMatch[] = [];

  // `matchAll` clones the regex, so a matcher can be reused across pages
  // without its `lastIndex` carrying over from the previous one.
  for (const match of text.matchAll(matcher)) {
    // A zero-length match cannot happen with the patterns compiled above, but
    // an empty span would loop the highlighter, so it is refused here rather
    // than defended against three times downstream.
    if (match[0].length === 0) continue;
    matches.push({ start: match.index, length: match[0].length });
  }

  return matches;
}

/**
 * Search a whole document, page by page, in page order.
 *
 * Ordering matters: "next match" walks this array, and a reader stepping
 * through results expects to move forward through the document rather than
 * around it.
 */
export function searchPages(
  pages: { pageNumber: number; text: string }[],
  query: string,
  limit = MAX_MATCHES,
): { matches: DocumentMatch[]; truncated: boolean } {
  const matcher = compileQuery(query);
  if (!matcher) return { matches: [], truncated: false };

  const matches: DocumentMatch[] = [];

  for (const page of pages) {
    for (const match of findMatches(page.text, matcher)) {
      if (matches.length >= limit) return { matches, truncated: true };
      matches.push({ ...match, pageNumber: page.pageNumber });
    }
  }

  return { matches, truncated: false };
}

/** The matches that fall on one page, in order. */
export function matchesOnPage(
  matches: DocumentMatch[],
  pageNumber: number,
): { match: DocumentMatch; index: number }[] {
  const found: { match: DocumentMatch; index: number }[] = [];
  matches.forEach((match, index) => {
    if (match.pageNumber === pageNumber) found.push({ match, index });
  });
  return found;
}
