/**
 * THE CITATION TARGETING CONTRACT.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 *
 * A citation resolves to a chunk, a chunk records `char_start`/`char_end` into
 * the document's concatenated text, and the viewer has to turn that range into
 * a highlight on screen. A PDF page and a paragraph of a Word document are
 * nothing alike as DOM — one is a canvas with an absolutely-positioned text
 * layer over it, the other is a `<p>` — and the obvious implementation ends up
 * with two highlighters, two sets of edge cases, and one of them quietly
 * broken because only PDFs get tested.
 *
 * So the two renderers agree on a contract instead: EVERY rendered page, in
 * every format, is an element carrying the same three attributes.
 *
 *     data-page-number   1-based page (or synthetic block)
 *     data-char-start    inclusive offset into the document's text
 *     data-char-end      exclusive offset into the document's text
 *
 * That is enough to answer the only question the highlighter asks — "which
 * element holds offset N, and where inside it?" — without knowing which
 * renderer produced the element. Finding the page is format-independent;
 * finding the position inside it is the only part that differs, and it differs
 * in exactly one way:
 *
 *   - TEXT documents additionally carry `data-char-start` on every paragraph
 *     and every text run, and the DOM text is the STORED text, character for
 *     character. An offset resolves by arithmetic. It is exact.
 *   - PDF pages carry the same page-level attributes, and the position inside
 *     is found in PDF.js's text layer, whose strings come from the file rather
 *     than from Postgres. Extraction normalised whitespace and rejoined
 *     hyphenated line breaks, so that step is a match rather than a lookup.
 *
 * The consequence worth stating plainly: page-level targeting — scroll to the
 * cited page, light the page — is identical and exact for both. Character-level
 * targeting is exact for text and best-effort for PDF. Everything above this
 * layer can be written once.
 *
 * Nothing here renders anything. It is the vocabulary both renderers spell the
 * same way, in one file, so they cannot drift.
 */

export const PAGE_NUMBER_ATTR = "data-page-number";
export const CHAR_START_ATTR = "data-char-start";
export const CHAR_END_ATTR = "data-char-end";

/** Marks the element that is one whole page. The highlighter's search root. */
export const PAGE_ROLE_ATTR = "data-viewer-page";

/** Props every page element gets, whichever renderer built it. */
export function pageAnchorProps(page: {
  pageNumber: number;
  charStart: number;
  charEnd: number;
}) {
  return {
    [PAGE_ROLE_ATTR]: "",
    [PAGE_NUMBER_ATTR]: page.pageNumber,
    [CHAR_START_ATTR]: page.charStart,
    [CHAR_END_ATTR]: page.charEnd,
  } as const;
}

/**
 * Props for a run of text inside a page.
 *
 * `charStart` here is DOCUMENT-relative, like everything else in the contract.
 * The renderers hold page-relative offsets internally because that is what
 * search returns; converting once, at the boundary where the attribute is
 * written, keeps a single coordinate system in the DOM.
 */
export function textAnchorProps(charStart: number) {
  return { [CHAR_START_ATTR]: charStart } as const;
}

/** The selector the highlighter uses to enumerate rendered pages. */
export const PAGE_SELECTOR = `[${PAGE_ROLE_ATTR}]`;
