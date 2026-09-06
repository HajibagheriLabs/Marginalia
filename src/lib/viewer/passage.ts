/**
 * FINDING A CITED PASSAGE IN A RENDERED PAGE.
 *
 * A citation stores `quoted_text` — the passage as it was handed to the model —
 * and the page it came from. The viewer has to turn that into a highlight over
 * the words on screen. Those words come from somewhere else: PDF.js's text
 * layer reads the file directly, while `quoted_text` came out of the extractor.
 * The two are the same passage and are almost never the same string.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY NOT OFFSETS
 *
 * The chunker recorded `char_start`/`char_end` into the extracted text, so it
 * is tempting to resolve a citation by arithmetic. That works for a text
 * document, where the DOM text IS the stored text — and cannot work for a PDF,
 * where the rendered text is PDF.js's own and shares no coordinate system with
 * Postgres. Two mechanisms would mean the PDF one is the untested one, and the
 * PDF one is the case that matters. So both formats resolve by matching text,
 * and the tests below are the tests for both.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE NORMALISATION, AND WHAT IT DELIBERATELY DESTROYS
 *
 * Matching happens on a reduced form of both strings. It removes:
 *
 *   ALL WHITESPACE. PDF.js emits one span per text item, and it splits items
 *     at font changes as well as at line ends — so a bold word mid-sentence
 *     arrives as its own span with no space around it, while a line break
 *     arrives as two spans that a reader sees as separated. There is no join
 *     character that is right for both. Removing whitespace from both sides
 *     makes the question moot, and it is also what makes a phrase match across
 *     the newline the extractor preserved.
 *   ALL HYPHENS. A word broken across a line is "termi-" + "nation" in the
 *     text layer and "termination" in the extracted text, because extraction
 *     rejoins hyphenation and PDF.js does not. Dropping hyphens on both sides
 *     is the only rule that closes that gap without knowing where the line
 *     breaks were.
 *   SOFT HYPHENS AND ZERO-WIDTH CHARACTERS, which are invisible and carry no
 *     meaning.
 *
 * And it folds curly quotes, dashes, and exotic spaces to their ASCII forms,
 * then lowercases.
 *
 * THE COST, STATED PLAINLY: "part-time" and "parttime" become the same string,
 * as do "the cat" and "thecat". Against a multi-sentence quote that is not a
 * risk worth a more elaborate rule. Against a SHORT fallback fragment it would
 * be, which is exactly why `MIN_SUBPHRASE_LENGTH` exists — a fragment shorter
 * than that is refused, and the viewer falls back to marking the page instead
 * of highlighting something that might be the wrong words. Highlighting the
 * wrong text is the one outcome this file exists to prevent.
 *
 * Every reduced character maps back to exactly one source character, so a match
 * in the reduced string is an exact range in the original.
 */

/** Zero-width and soft-hyphen characters: invisible, and meaningless here. */
const INVISIBLE = /[­​‌‍⁠﻿]/;

/** Every dash a document might use, including the one a keyboard produces. */
const HYPHEN = /[-‐‑‒–—―−]/;

/** 1:1 folds. Expansions are not allowed — the map depends on one char in, one out. */
const FOLD: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "‚": "'",
  "‛": "'",
  "′": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "‟": '"',
  "″": '"',
};

/**
 * The shortest fragment the fallback will highlight, in reduced characters.
 *
 * Roughly four or five words. Below this, a match found in a page of legal
 * prose is as likely to be a coincidence as the passage — and a highlight over
 * the wrong sentence is worse than no highlight, because it is a claim about
 * where the answer came from.
 */
export const MIN_SUBPHRASE_LENGTH = 24;

export interface ReducedText {
  /** Whitespace-free, hyphen-free, lowercased. */
  text: string;
  /** `map[i]` is the index in the source of the character that produced `text[i]`. */
  map: number[];
}

export function reduceForMatch(source: string): ReducedText {
  const out: string[] = [];
  const map: number[] = [];

  for (let index = 0; index < source.length; index += 1) {
    const raw = source[index];
    const folded = FOLD[raw] ?? raw;

    if (INVISIBLE.test(folded)) continue;
    if (HYPHEN.test(folded)) continue;
    // \s covers every space character including NBSP and the exotic ones.
    if (/\s/.test(folded)) continue;

    // A locale-aware lowercase can produce more than one character. Each gets
    // the same source index, so the map stays the same length as the text and
    // every position still resolves to a real character in the source.
    const lower = folded.toLowerCase();
    for (const character of lower) {
      out.push(character);
      map.push(index);
    }
  }

  return { text: out.join(""), map };
}

/** How the passage was located. The UI says so when it is not exact. */
export type PassageMatchKind = "exact" | "partial";

export interface PassageMatch {
  /** Inclusive index into the ORIGINAL haystack. */
  start: number;
  /** Exclusive index into the ORIGINAL haystack. */
  end: number;
  kind: PassageMatchKind;
  /** Fraction of the quote that was located, 0–1. 1 for an exact match. */
  coverage: number;
}

/**
 * Locate `quote` inside `haystack`.
 *
 * Returns null rather than guessing. A null is the signal for the page-level
 * fallback, which tells the reader plainly that the exact passage was not
 * found — the alternative, highlighting a best guess, would be the interface
 * asserting provenance it does not have.
 */
export function locatePassage(
  haystack: string,
  quote: string,
): PassageMatch | null {
  const reducedHaystack = reduceForMatch(haystack);
  const reducedQuote = reduceForMatch(quote);

  if (reducedQuote.text.length === 0 || reducedHaystack.text.length === 0) {
    return null;
  }

  const exact = reducedHaystack.text.indexOf(reducedQuote.text);
  if (exact !== -1) {
    return {
      ...toSourceRange(reducedHaystack, exact, reducedQuote.text.length),
      kind: "exact",
      coverage: 1,
    };
  }

  /* ── FALLBACK: THE LONGEST MATCHING SUB-PHRASE ────────────────────────────
   * The two realistic reasons an exact match fails are that the passage runs
   * off the end of this page, or that extraction and PDF.js disagree about a
   * character somewhere in the middle. Both leave one END of the quote intact,
   * so the longest matching prefix and the longest matching suffix between
   * them cover almost every real case.
   *
   * Both are found by binary search, which is valid because presence is
   * monotone: if a prefix of length k is on the page, so is every shorter one.
   * That is O(log n) substring searches rather than the O(n²) scan a general
   * longest-common-substring would cost on every click.
   */
  const prefix = longestPrefix(reducedHaystack.text, reducedQuote.text);
  const suffix = longestSuffix(reducedHaystack.text, reducedQuote.text);
  const best = prefix.length >= suffix.length ? prefix : suffix;

  if (best.length < MIN_SUBPHRASE_LENGTH) return null;

  return {
    ...toSourceRange(reducedHaystack, best.at, best.length),
    kind: "partial",
    coverage: best.length / reducedQuote.text.length,
  };
}

/** Translate a range in the reduced text back to the original string. */
function toSourceRange(
  reduced: ReducedText,
  at: number,
  length: number,
): { start: number; end: number } {
  return {
    start: reduced.map[at],
    // The end is exclusive, and the last matched reduced character came from
    // exactly one source character, so its index plus one is the boundary.
    end: reduced.map[at + length - 1] + 1,
  };
}

function longestPrefix(
  haystack: string,
  quote: string,
): { at: number; length: number } {
  let low = 0;
  let high = quote.length;
  let bestAt = -1;

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const at = haystack.indexOf(quote.slice(0, middle));
    if (at === -1) {
      high = middle - 1;
    } else {
      low = middle;
      bestAt = at;
    }
  }

  return { at: bestAt, length: low };
}

function longestSuffix(
  haystack: string,
  quote: string,
): { at: number; length: number } {
  let low = 0;
  let high = quote.length;
  let bestAt = -1;

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const at = haystack.indexOf(quote.slice(quote.length - middle));
    if (at === -1) {
      high = middle - 1;
    } else {
      low = middle;
      bestAt = at;
    }
  }

  return { at: bestAt, length: low };
}
