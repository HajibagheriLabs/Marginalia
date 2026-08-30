import { getEncoding, type Tiktoken } from "js-tiktoken";

/**
 * STAGE 2 OF INGESTION: CHUNKING.
 *
 * Turns one document's concatenated text into the passages that will be
 * embedded, indexed, retrieved, and cited. Pure: no database, no network, no
 * model. `extract.ts` produces the text and the pages, this file produces the
 * chunks, and a later `chunk-stage.ts` persists them.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE MATTERS MORE THAN IT LOOKS
 *
 * Retrieval quality is decided here, before a single vector exists. A chunk is
 * the unit of everything downstream: it is what gets embedded, so it is what
 * similarity is measured over; it is what gets returned, so it is what the
 * model sees; and it is what a citation points at, so it is what the reader
 * ends up staring at on the page. Chunk badly and no reranker, no fusion
 * weight, and no prompt rescues it — the answer simply is not in the context.
 *
 * Three failure modes this code is built to avoid:
 *
 *   1. SPLITTING MID-THOUGHT. A clause cut in half embeds as two vectors that
 *      each mean less than the whole, and cites as a passage that reads as a
 *      fragment. Hence: split on structure first, sentences next, characters
 *      only when a single sentence is itself over budget.
 *
 *   2. CONTEXT-FREE CHUNKS. "It may be terminated on thirty days' notice" is a
 *      perfectly good passage that is useless as a vector, because nothing in
 *      it says WHAT may be terminated or WHICH agreement it belongs to. Hence
 *      the section breadcrumb and the context header — see `embeddingText`.
 *
 *   3. STRAY FRAGMENTS. A 20-token chunk outranks real passages on short
 *      queries — it is mostly signal-free, so cosine similarity against it is
 *      noise — and then occupies a slot in the final context that a real
 *      answer needed. Hence the hard minimum and the merge pass.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE OFFSET GUARANTEE, CONTINUED
 *
 * `extract.ts` promises `documentText.slice(page.charStart, page.charEnd) ===
 * page.text`. This file extends the same promise to chunks:
 *
 *     documentText.slice(chunk.charStart, chunk.charEnd) === chunk.text
 *
 * It holds because chunk text is never constructed — it is only ever SLICED out
 * of the document text. Nothing here trims, rewrites, joins, or normalizes a
 * chunk's content. Everything the chunker does is decide two integers; the text
 * falls out of them. That is what makes a citation resolvable: chunk ->
 * offsets -> page -> highlight, with no step along the way that could have
 * altered the text.
 *
 * The context header (document title, section path) is the one piece of text
 * this file synthesizes, and it is deliberately NOT part of the chunk. It is
 * produced on demand by `embeddingText` and handed straight to the embedder.
 * It is never stored and never displayed.
 * ───────────────────────────────────────────────────────────────────────────
 */

/* ========================================================================== *
 * TUNING
 *
 * Every number that shapes a chunk lives in this one object. It is the surface
 * the eval harness will move: change a value here, re-ingest the eval corpus,
 * compare recall. Nothing below reads a magic number that is not defined here,
 * so there is no second place to keep in sync.
 * ========================================================================== */

export const CHUNKING = {
  /**
   * The size a chunk is packed toward. Once a chunk reaches this, it closes.
   *
   * The tradeoff runs in both directions and there is no universally right
   * answer, which is exactly why it is a constant and not an assumption baked
   * into the code. SMALLER chunks give sharper vectors and more precise
   * citations, but split reasoning that spans a paragraph boundary and spend
   * more of the context window on repeated headers. LARGER chunks keep an
   * argument intact, but a single vector averaged over 900 tokens is a blur: it
   * matches everything a little and nothing well.
   *
   * READ THIS BEFORE THE FIRST EVAL RUN.
   * These are cl100k (tiktoken) tokens. The embedding model is
   * bge-small-en-v1.5, whose encoder is BERT WordPiece with a HARD 512-token
   * limit, and which produces roughly 1.1-1.2x as many tokens as cl100k for
   * English prose. A 700-token chunk by this count is therefore ~770-840 BGE
   * tokens, and Transformers.js will TRUNCATE it at 512 — silently, with no
   * error, dropping the tail of every long chunk from the vector while the
   * stored text keeps it. Retrieval then misses answers that are demonstrably
   * present in the passage, which is close to impossible to diagnose from the
   * outside.
   *
   * Two ways out, to be decided with eval numbers rather than from the
   * armchair: drop `targetTokens` to ~380-420 so the augmented text fits inside
   * 512, or swap `countTokens` for the model's own tokenizer through
   * `ChunkOptions.countTokens` and set the budget in BGE tokens directly. The
   * seam for the second is already here; see `TokenCounter`.
   */
  targetTokens: 700,

  /**
   * Hard ceiling. A chunk may run past `targetTokens` to finish absorbing a
   * unit it has already started on, but never past this. The gap between the
   * two is the slack that lets a paragraph land whole instead of being torn.
   *
   * The one documented exception is the merge pass below, which may push a
   * chunk to `maxTokens + minTokens` rather than emit a fragment.
   */
  maxTokens: 900,

  /**
   * No chunk below this survives; it is merged into its neighbour.
   *
   * A floor, not a target — see failure mode 3 above. It is enforced after
   * packing rather than during it, because whether a chunk is too small is only
   * knowable once it is closed.
   */
  minTokens: 100,

  /**
   * How full a chunk must be before a heading is allowed to close it, as a
   * fraction of `targetTokens`. The effective threshold is never below
   * `minTokens`, so 0 means "break at every heading that leaves a legal chunk".
   *
   * This is the knob for the one place the project's two chunking rules pull
   * against each other: "split on structure first" and "target ~700 tokens". A
   * contract is not a handful of long sections — it is two hundred short
   * numbered clauses, and honouring every heading turns such a document into
   * two hundred 150-token passages that never approach the budget.
   *
   * It defaults to structure-first anyway, for two reasons. A short chunk that
   * is exactly one clause is a BETTER retrieval unit than a full chunk holding
   * six unrelated ones: the vector means one thing instead of averaging six,
   * and the context header already supplies the surrounding context that a
   * short passage would otherwise lack. And `section_path` stays true — a chunk
   * that spans a heading can only be labelled with one of the sections it
   * covers, and a citation chip that names the wrong clause is worse than a
   * small chunk, since the breadcrumb is the thing that makes a citation
   * legible in the first place.
   *
   * Raise it toward 1.0 to pack fuller, more topic-mixed chunks and accept
   * approximate breadcrumbs. That is a trade worth measuring once the eval
   * harness exists; it is not one worth guessing at now.
   */
  sectionBreakRatio: 0,

  /**
   * Overlap, as a fraction of `targetTokens` (0.15 -> ~105 tokens).
   *
   * Overlap exists for one reason: a sentence at a chunk boundary answers a
   * question using a subject named in the previous sentence, and without
   * overlap neither chunk contains both halves. It is redundancy bought
   * deliberately — ~15% more vectors, ~15% more storage, and duplicated text in
   * the context when two adjacent chunks are both retrieved.
   *
   * Set to 0 to turn it off entirely.
   */
  overlapRatio: 0.15,

  /**
   * A line longer than this is prose, not a heading, whatever it looks like.
   * The single cheapest guard against a wrapped paragraph's first line being
   * promoted to a section title.
   */
  maxHeadingChars: 100,

  /** Breadcrumbs truncate from the LEFT past this; the leaf is what matters. */
  maxSectionPathChars: 200,

  /**
   * Treat a short ALL-CAPS line as a heading.
   *
   * Right for contracts and statutes, where "TERMINATION" on its own line is
   * unambiguously a section title. Wrong for PDFs with a running header, where
   * "CONFIDENTIAL - DRAFT" repeats on every page and pollutes every breadcrumb
   * in the document. Left on because the first case is this product's actual
   * corpus, and exposed because the second case is real.
   */
  detectAllCapsHeadings: true,
} as const;

/** The breadcrumb separator, and the separator inside the context header. */
export const SECTION_SEPARATOR = " › ";

/* ========================================================================== *
 * TOKEN COUNTING
 * ========================================================================== */

/**
 * How tokens are counted. Swappable so the budget can be expressed in the
 * EMBEDDING model's tokens rather than an approximation of them — see the
 * warning on `CHUNKING.targetTokens`.
 */
export type TokenCounter = (text: string) => number;

/**
 * Loaded ONCE, lazily, at module scope.
 *
 * `getEncoding` parses a rank table of well over a megabyte. Building it per
 * call turns a sub-millisecond count into a multi-hundred-millisecond one, and
 * chunking a long document calls it thousands of times. Same reasoning, and the
 * same shape, as the embedding pipeline singleton.
 */
let encoder: Tiktoken | null = null;

function encoding(): Tiktoken {
  encoder ??= getEncoding("cl100k_base");
  return encoder;
}

/**
 * Count tokens with a real BPE tokenizer.
 *
 * Not `text.length / 4`. That ratio is an average over English prose and is
 * wrong in exactly the places this project cares about: dense legal citations,
 * tables of figures, drug names, and anything non-English all tokenize far
 * denser than four characters per token, so a character estimate silently
 * produces chunks that overflow the embedding window.
 *
 * The `[], []` arguments matter. js-tiktoken defaults to `disallowedSpecial:
 * "all"`, which THROWS if the text contains a literal `<|endoftext|>` — a
 * string that appears in perfectly ordinary documents about language models,
 * and one an uploaded PDF is entitled to contain. Passing empty arrays means
 * "no special tokens are recognised, and none are forbidden": the sequence is
 * encoded as the ordinary characters it is.
 */
export function countTokens(text: string): number {
  if (text.length === 0) return 0;
  return encoding().encode(text, [], []).length;
}

/* ========================================================================== *
 * TYPES
 * ========================================================================== */

/**
 * The part of a page this file needs. Structural rather than an import of
 * `ExtractedPage` or the `document_pages` row type, so the chunker can be
 * called with either a fresh extraction result or rows read back from Postgres
 * without a conversion step.
 */
export interface PageSpan {
  pageNumber: number;
  charStart: number;
  charEnd: number;
}

/** One retrievable passage. Maps 1:1 onto a `chunks` row. */
export interface DocumentChunk {
  /** 0-based position in the document. */
  ordinal: number;
  /** ORIGINAL text, sliced from the document. Never the augmented form. */
  text: string;
  tokenCount: number;
  /** 1-based, inclusive. Equal to `pageTo` unless the chunk crosses a break. */
  pageFrom: number;
  pageTo: number;
  /** Inclusive offset into the document text. */
  charStart: number;
  /** Exclusive offset into the document text. */
  charEnd: number;
  /** Heading breadcrumb, e.g. "Article 7 › 7.3 Termination". Null at the root. */
  sectionPath: string | null;
}

export interface ChunkOptions {
  targetTokens?: number;
  maxTokens?: number;
  minTokens?: number;
  sectionBreakRatio?: number;
  overlapRatio?: number;
  maxHeadingChars?: number;
  maxSectionPathChars?: number;
  detectAllCapsHeadings?: boolean;
  /** Defaults to `countTokens`. The seam for the embedding model's tokenizer. */
  countTokens?: TokenCounter;
}

export interface ChunkInput {
  /** The document's concatenated page text, exactly as extraction produced it. */
  text: string;
  /** That document's pages. Used only to resolve offsets to page numbers. */
  pages: readonly PageSpan[];
  options?: ChunkOptions;
}

type ResolvedOptions = Required<Omit<ChunkOptions, "countTokens">> & {
  countTokens: TokenCounter;
};

function resolveOptions(options: ChunkOptions = {}): ResolvedOptions {
  return {
    targetTokens: options.targetTokens ?? CHUNKING.targetTokens,
    maxTokens: options.maxTokens ?? CHUNKING.maxTokens,
    minTokens: options.minTokens ?? CHUNKING.minTokens,
    sectionBreakRatio: options.sectionBreakRatio ?? CHUNKING.sectionBreakRatio,
    overlapRatio: options.overlapRatio ?? CHUNKING.overlapRatio,
    maxHeadingChars: options.maxHeadingChars ?? CHUNKING.maxHeadingChars,
    maxSectionPathChars:
      options.maxSectionPathChars ?? CHUNKING.maxSectionPathChars,
    detectAllCapsHeadings:
      options.detectAllCapsHeadings ?? CHUNKING.detectAllCapsHeadings,
    countTokens: options.countTokens ?? countTokens,
  };
}

/* ========================================================================== *
 * THE CONTEXT HEADER
 * ========================================================================== */

/**
 * The string that actually gets embedded.
 *
 *     "<document title> — <section path>\n\n<chunk text>"
 *
 * WHY. Half the passages in any structured document are meaningless in
 * isolation. "The period is thirty (30) days." is a complete, correctly
 * chunked, entirely ordinary sentence whose embedding is near-useless: it has
 * no subject, so it sits nowhere near "how much notice must the customer give
 * to terminate?" in vector space. The heading it lives under — "Article 7 ›
 * 7.3 Termination for convenience" — is precisely the missing subject, and it
 * is already known at ingestion time for free.
 *
 * This is the highest-return line of code in the retrieval pipeline. It costs
 * one string concatenation per chunk, adds no API call, no model, and no
 * latency at query time, and it repairs the single largest category of
 * retrieval miss in document Q&A. Every other lever available here — fusion
 * weights, reranking, query rewriting — costs more and moves less.
 *
 * What it is NOT: part of the chunk. The header is prepended for the embedder
 * and then thrown away. `chunk.text` stays the original slice, so the passage
 * shown beside a citation is the document's own words, the highlight offsets
 * still line up, and the lexical index is not stuffed with the same heading
 * repeated across forty chunks.
 */
export function embeddingText(
  chunk: Pick<DocumentChunk, "text" | "sectionPath">,
  documentTitle: string,
): string {
  const title = documentTitle.trim();
  const path = chunk.sectionPath?.trim();

  const header = path ? (title ? `${title} — ${path}` : path) : title;
  return header ? `${header}\n\n${chunk.text}` : chunk.text;
}

/* ========================================================================== *
 * HEADING DETECTION
 *
 * Structure is the first split, so this is where structure is found. Two very
 * different inputs have to work:
 *
 *   - Markdown and DOCX, which arrive with explicit `#` markers because
 *     `docxHtmlToText` put them there;
 *   - PDF text, which has no markers at all and where a heading is just a short
 *     line that looks like one.
 *
 * The heuristics for the second case are all built the same way: a heading is
 * SHORT, it stands on its own line, and it does not end like a sentence. Those
 * three together are what keep the first line of a wrapped paragraph from being
 * promoted to a section title.
 * ========================================================================== */

interface Heading {
  /** 1 = outermost. Gaps in the sequence are fine; the stack handles them. */
  level: number;
  title: string;
}

/** `# Title`, `## Title ##`. The unambiguous case. */
const ATX = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;

/** A `Title` line followed by `=====` or `-----`. */
const SETEXT_UNDERLINE = /^(={2,}|-{2,})$/;

/** "ARTICLE 7 - TERMINATION", "Schedule B", "Part IV". */
const KEYWORD_HEADING =
  /^(part|article|chapter|section|clause|appendix|schedule|exhibit|annex|title)\s+(\d+|[ivxlcdm]+|[a-z])\b/i;

/** "7.", "7.3 Termination", "2.14.1 Dosing". */
const NUMBERED_HEADING = /^(\d+(?:\.\d+)*)\.?[ \t]+(\S.*)$/;

/** Ends like a sentence or a continuing clause, so it is not a title. */
const SENTENCE_TAIL = /[.,;]$/;

/**
 * Classify one line.
 *
 * The order is significance, not convenience: an explicit marker always beats a
 * guess, and a guess about numbering beats a guess about capitalisation.
 */
function detectHeading(line: string, options: ResolvedOptions): Heading | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  const atx = ATX.exec(trimmed);
  if (atx) {
    const title = atx[2].trim();
    return title ? { level: atx[1].length, title } : null;
  }

  // Everything past this point is a heuristic, and every heuristic is gated on
  // the line being short enough to be a title in the first place.
  if (trimmed.length > options.maxHeadingChars) return null;
  if (SENTENCE_TAIL.test(trimmed)) return null;
  if (!/[A-Za-z]/.test(trimmed)) return null;

  if (KEYWORD_HEADING.test(trimmed)) {
    return { level: 1, title: trimmed };
  }

  const numbered = NUMBERED_HEADING.exec(trimmed);
  if (numbered && /[A-Za-z]/.test(numbered[2])) {
    // Depth comes from the numbering itself: "7" nests one level, "7.3" two,
    // "7.3.1" three. Offset by one so a numbered clause sits UNDER an
    // "ARTICLE 7" style heading rather than beside it.
    const depth = numbered[1].split(".").length;
    return { level: Math.min(6, depth + 1), title: trimmed };
  }

  if (options.detectAllCapsHeadings && isAllCapsHeading(trimmed)) {
    return { level: 1, title: trimmed };
  }

  return null;
}

/** Short, shouty, and at least a word long. See CHUNKING.detectAllCapsHeadings. */
function isAllCapsHeading(line: string): boolean {
  const letters = line.replace(/[^A-Za-z]/g, "");
  if (letters.length < 3) return false;
  return letters === letters.toUpperCase();
}

/**
 * The breadcrumb stack.
 *
 * A heading at level L closes every open section at level >= L and opens its
 * own. That single rule produces correct nesting for well-formed documents and
 * something sensible for malformed ones — a document that jumps from `#` to
 * `####` gets a two-entry path rather than an error, which is the right
 * behaviour for input nobody controls.
 */
class SectionStack {
  private readonly entries: Heading[] = [];

  constructor(private readonly maxChars: number) {}

  push(heading: Heading): void {
    while (
      this.entries.length > 0 &&
      this.entries[this.entries.length - 1].level >= heading.level
    ) {
      this.entries.pop();
    }
    this.entries.push(heading);
  }

  /** The breadcrumb, or null at the document root. */
  path(): string | null {
    if (this.entries.length === 0) return null;

    const titles = this.entries.map((entry) => entry.title);
    let path = titles.join(SECTION_SEPARATOR);

    // Truncate from the LEFT. The leaf is the section the passage is actually
    // in; the ancestors are context, and context is what you drop first.
    while (titles.length > 1 && path.length > this.maxChars) {
      titles.shift();
      path = `…${SECTION_SEPARATOR}${titles.join(SECTION_SEPARATOR)}`;
    }

    return path;
  }
}

/* ========================================================================== *
 * SENTENCE SPLITTING
 *
 * Only ever reached for a paragraph that is over budget on its own. A regex
 * sentence splitter is wrong on a long enough tail of inputs that it is worth
 * saying plainly what this one does and does not handle.
 * ========================================================================== */

/**
 * Words whose trailing period is not a full stop.
 *
 * Weighted toward the corpora this product is aimed at: contracts, clinical
 * guidelines, and papers. Splitting "administered 5 mg. daily" or "see Art. 7
 * below" into two sentences is not a cosmetic error — it is how a dosage or a
 * cross-reference ends up on the wrong side of a chunk boundary.
 */
const ABBREVIATIONS = new Set([
  // Titles and names
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "rev", "hon",
  // Reference and citation
  "no", "nos", "art", "arts", "sec", "secs", "cl", "para", "paras", "pp",
  "fig", "figs", "ref", "refs", "ch", "chs", "vol", "vols", "ed", "eds",
  "cf", "vs", "v", "al", "ibid", "op", "seq", "supra", "infra",
  // Organisational
  "inc", "ltd", "llc", "llp", "plc", "co", "corp", "dept", "univ", "assn",
  "bros", "n.v", "s.a",
  // Latin and general
  "e.g", "i.e", "etc", "approx", "est", "incl", "excl", "min", "max", "avg",
  // Dotted initialisms
  "u.s", "u.k", "e.u", "a.m", "p.m", "b.c", "a.d", "ph.d", "m.d",
  // Units seen in clinical text
  "mg", "ml", "mcg", "kg", "iu", "mmhg", "hr", "hrs", "wk", "wks", "yr", "yrs",
]);

/** Closing punctuation that may sit between the full stop and the space. */
const CLOSERS = /[")'\]}»”’]/;

/** What the next sentence is allowed to start with. */
const SENTENCE_START = /[\p{Lu}\p{N}"'“‘([«#•-]/u;

/**
 * Decide whether the period at `index` ends a sentence.
 *
 * Reads backwards over the word attached to the period — including any interior
 * dots, so "e.g." is examined as "e.g" rather than as "g" — and checks it
 * against the abbreviation list. Two rules beyond the list:
 *
 *   - A single letter is always an initial ("J. Smith", "Section A. Scope").
 *   - A bare number at the START of a line is a list marker ("1. The Provider
 *     shall...") and not the end of anything, while the same number mid-line is
 *     an ordinary date or figure ("...in 1999. The parties then...").
 */
function endsAbbreviation(text: string, start: number, index: number): boolean {
  let cursor = index;
  while (cursor > start && /[A-Za-z.]/.test(text[cursor - 1])) cursor -= 1;

  const word = text.slice(cursor, index).replace(/^\.+/, "").toLowerCase();

  if (word.length === 0) {
    // Digits, or nothing at all, precede the period.
    let digits = index;
    while (digits > start && /\d/.test(text[digits - 1])) digits -= 1;
    if (digits === index) return false;
    // A list marker is a number with only whitespace before it on its line.
    const lineStart = text.lastIndexOf("\n", digits - 1) + 1;
    return text.slice(Math.max(lineStart, start), digits).trim().length === 0;
  }

  if (word.length === 1) return true;
  return ABBREVIATIONS.has(word);
}

/**
 * Split `[start, end)` into sentence ranges.
 *
 * Ranges are trimmed, so the whitespace between two sentences belongs to
 * neither — the same convention the block splitter uses. See the coverage note
 * on `chunkDocument`.
 */
function splitSentences(
  text: string,
  start: number,
  end: number,
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let sentenceStart = start;
  let i = start;

  while (i < end) {
    const ch = text[i];
    if (ch !== "." && ch !== "!" && ch !== "?") {
      i += 1;
      continue;
    }

    // "?!", "..." and friends all terminate together.
    let after = i + 1;
    while (after < end && /[.!?]/.test(text[after])) after += 1;
    while (after < end && CLOSERS.test(text[after])) after += 1;

    if (after >= end) break;
    if (!/\s/.test(text[after])) {
      // No space after the stop: a decimal, a version number, a URL.
      i = after;
      continue;
    }

    let next = after;
    while (next < end && /\s/.test(text[next])) next += 1;
    if (next >= end) break;

    if (ch === "." && endsAbbreviation(text, start, i)) {
      i = after;
      continue;
    }
    if (!SENTENCE_START.test(text[next])) {
      i = after;
      continue;
    }

    pushTrimmed(ranges, text, sentenceStart, after);
    sentenceStart = next;
    i = next;
  }

  pushTrimmed(ranges, text, sentenceStart, end);
  return ranges;
}

/** Append `[start, end)` with surrounding whitespace removed, if anything remains. */
function pushTrimmed(
  ranges: Array<[number, number]>,
  text: string,
  start: number,
  end: number,
): void {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s])) s += 1;
  while (e > s && /\s/.test(text[e - 1])) e -= 1;
  if (e > s) ranges.push([s, e]);
}

/* ========================================================================== *
 * BLOCKS: THE FIRST SPLIT
 * ========================================================================== */

interface Block {
  start: number;
  end: number;
  heading: Heading | null;
}

/**
 * Walk the document line by line and group it into headings and paragraphs.
 *
 * LINE BY LINE, not paragraph by paragraph, and that choice is load-bearing.
 * Markdown has blank lines between paragraphs; PDF text routinely has none at
 * all — every visual line ends in `\n` and a blank line never appears. Scanning
 * paragraphs would see such a document as one enormous block with no structure
 * in it, and every heading in a 200-page contract would be lost. Scanning lines
 * finds the headings in both.
 *
 * A block therefore ends at a blank line, at a heading, or at the end of the
 * document — whichever comes first.
 */
function splitBlocks(text: string, options: ResolvedOptions): Block[] {
  const blocks: Block[] = [];
  let blockStart = -1;
  let blockEnd = -1;

  const closeBlock = () => {
    if (blockStart >= 0) {
      blocks.push({ start: blockStart, end: blockEnd, heading: null });
      blockStart = -1;
    }
  };

  let cursor = 0;
  for (;;) {
    const newline = text.indexOf("\n", cursor);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(cursor, lineEnd);

    if (line.trim().length === 0) {
      closeBlock();
    } else {
      // Setext: this line is a heading only because the NEXT line underlines it.
      const underline = peekLine(text, lineEnd);
      const isSetext =
        underline !== null &&
        SETEXT_UNDERLINE.test(underline.text.trim()) &&
        line.trim().length <= options.maxHeadingChars &&
        !ATX.test(line.trim());

      if (isSetext && underline) {
        closeBlock();
        blocks.push({
          start: cursor,
          end: underline.end,
          heading: {
            level: underline.text.trim().startsWith("=") ? 1 : 2,
            title: line.trim(),
          },
        });
        // The underline is consumed with the title: it is part of the heading.
        cursor = underline.end + 1;
        if (underline.end >= text.length) break;
        continue;
      }

      const heading = detectHeading(line, options);
      if (heading) {
        closeBlock();
        blocks.push({ start: cursor, end: lineEnd, heading });
      } else {
        if (blockStart < 0) blockStart = cursor;
        blockEnd = lineEnd;
      }
    }

    if (newline === -1) break;
    cursor = newline + 1;
  }

  closeBlock();

  // Trim each block so its offsets bound real text, never the whitespace that
  // separated it from its neighbours.
  return blocks
    .map((block): Block | null => {
      const trimmed: Array<[number, number]> = [];
      pushTrimmed(trimmed, text, block.start, block.end);
      return trimmed.length > 0
        ? { start: trimmed[0][0], end: trimmed[0][1], heading: block.heading }
        : null;
    })
    .filter((block): block is Block => block !== null);
}

function peekLine(
  text: string,
  lineEnd: number,
): { text: string; end: number } | null {
  if (lineEnd >= text.length) return null;
  const start = lineEnd + 1;
  const newline = text.indexOf("\n", start);
  const end = newline === -1 ? text.length : newline;
  return { text: text.slice(start, end), end };
}

/* ========================================================================== *
 * UNITS: THE ATOMS A CHUNK IS BUILT FROM
 * ========================================================================== */

/**
 * The smallest span the packer will move around.
 *
 * Producing units is where the split hierarchy is actually enforced: a block
 * becomes ONE unit if it fits, sentences if it does not, and character
 * fragments only if a single sentence is itself over budget. By the time
 * packing runs, every unit is guaranteed to fit inside a chunk, so the packer
 * never has to make a splitting decision of its own.
 */
interface Unit {
  start: number;
  end: number;
  tokens: number;
  isHeading: boolean;
  /** The breadcrumb in force at this unit, headings included. */
  sectionPath: string | null;
}

function buildUnits(
  text: string,
  blocks: Block[],
  options: ResolvedOptions,
): Unit[] {
  const units: Unit[] = [];
  const stack = new SectionStack(options.maxSectionPathChars);

  for (const block of blocks) {
    if (block.heading) {
      stack.push(block.heading);
      units.push({
        start: block.start,
        end: block.end,
        tokens: options.countTokens(text.slice(block.start, block.end)),
        isHeading: true,
        sectionPath: stack.path(),
      });
      continue;
    }

    const sectionPath = stack.path();
    const blockTokens = options.countTokens(text.slice(block.start, block.end));

    if (blockTokens <= options.targetTokens) {
      units.push({
        start: block.start,
        end: block.end,
        tokens: blockTokens,
        isHeading: false,
        sectionPath,
      });
      continue;
    }

    // Over budget as a paragraph: fall to sentences.
    for (const [start, end] of splitSentences(text, block.start, block.end)) {
      const tokens = options.countTokens(text.slice(start, end));
      if (tokens <= options.targetTokens) {
        units.push({ start, end, tokens, isHeading: false, sectionPath });
        continue;
      }

      // Over budget as a single sentence. This is the last resort, and the only
      // place in the pipeline that cuts text at a point no author chose. It
      // happens for machine-generated documents, for OCR of a table read as one
      // line, and for legal drafting that runs two pages without a full stop.
      for (const [pieceStart, pieceEnd] of hardSplit(text, start, end, options)) {
        units.push({
          start: pieceStart,
          end: pieceEnd,
          tokens: options.countTokens(text.slice(pieceStart, pieceEnd)),
          isHeading: false,
          sectionPath,
        });
      }
    }
  }

  return units;
}

/**
 * Cut an over-long span into pieces that fit the budget, preferring whitespace.
 *
 * Works in characters rather than tokens deliberately. Slicing the token array
 * and decoding a prefix would be more direct, but cl100k is a BYTE-level BPE: a
 * token boundary is not necessarily a character boundary, so decoding a prefix
 * can produce a replacement character and an offset that no longer lines up
 * with the source text. Offsets are the one thing that must not drift, so the
 * split stays in character space and the tokenizer is used only to measure.
 */
function hardSplit(
  text: string,
  start: number,
  end: number,
  options: ResolvedOptions,
): Array<[number, number]> {
  const pieces: Array<[number, number]> = [];
  let cursor = start;

  while (cursor < end) {
    const remaining = text.slice(cursor, end);
    const remainingTokens = options.countTokens(remaining);
    if (remainingTokens <= options.targetTokens) {
      pushTrimmed(pieces, text, cursor, end);
      break;
    }

    // Proportional first guess, then shrink until it actually fits. Converges
    // in an iteration or two, because the estimate is only wrong where the
    // token density is uneven.
    let length = Math.max(
      1,
      Math.floor((remaining.length * options.targetTokens) / remainingTokens),
    );
    while (
      length > 1 &&
      options.countTokens(remaining.slice(0, length)) > options.targetTokens
    ) {
      length = Math.floor(length * 0.9);
    }

    // Retreat to a word boundary if one is close, so the cut lands between
    // words rather than inside one.
    const window = remaining.slice(0, length);
    const floor = Math.floor(length * 0.8);
    const breakAt = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\n"));
    if (breakAt >= floor) length = breakAt;

    pushTrimmed(pieces, text, cursor, cursor + length);
    cursor += length;
    // Step over the whitespace the cut landed on.
    while (cursor < end && /\s/.test(text[cursor])) cursor += 1;
  }

  return pieces;
}

/* ========================================================================== *
 * PACKING
 * ========================================================================== */

/** A chunk under construction: a contiguous run of units. */
interface Packed {
  first: number;
  last: number;
  tokens: number;
}

function packUnits(units: Unit[], options: ResolvedOptions): Packed[] {
  const packed: Packed[] = [];
  let current: Packed | null = null;

  // A heading only closes a chunk once the chunk is this full. See
  // CHUNKING.sectionBreakRatio for why a section boundary is preferred rather
  // than obeyed.
  const sectionBreakAt = Math.max(
    options.minTokens,
    Math.round(options.targetTokens * options.sectionBreakRatio),
  );

  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];

    if (current) {
      const full = current.tokens >= options.targetTokens;
      const overflows = current.tokens + unit.tokens > options.maxTokens;
      const sectionBreak = unit.isHeading && current.tokens >= sectionBreakAt;

      if (full || overflows || sectionBreak) {
        packed.push(current);
        current = null;
      }
    }

    if (current) {
      current.last = index;
      current.tokens += unit.tokens;
    } else {
      current = { first: index, last: index, tokens: unit.tokens };
    }
  }

  if (current) packed.push(current);
  return packed;
}

/**
 * Absorb chunks that came out under `minTokens`.
 *
 * Packing can only produce a runt in two situations: the document ran out mid
 * chunk, or a single very large unit forced a flush before the current chunk
 * had filled. Both leave a fragment that would pollute retrieval, so it is
 * merged into a neighbour.
 *
 * Backwards by preference. A short tail almost always belongs to the section
 * above it — it is the last sentence of a clause, not the first of the next —
 * and merging backwards also keeps `section_path` honest, since the path is
 * taken from the chunk's first unit either way.
 *
 * The merged chunk may exceed `maxTokens`, by at most `minTokens`. That is the
 * intended trade: the floor is a rule about retrieval quality, the ceiling is a
 * budget, and the rule wins.
 */
function mergeUndersized(packed: Packed[], options: ResolvedOptions): Packed[] {
  if (packed.length <= 1) return packed;

  const merged: Packed[] = [];

  for (const chunk of packed) {
    const previous = merged[merged.length - 1];
    if (previous && chunk.tokens < options.minTokens) {
      previous.last = chunk.last;
      previous.tokens += chunk.tokens;
      continue;
    }
    merged.push({ ...chunk });
  }

  // The first chunk has no predecessor to merge into, so it merges forward.
  while (merged.length > 1 && merged[0].tokens < options.minTokens) {
    const [first, second] = merged;
    second.first = first.first;
    second.tokens += first.tokens;
    merged.shift();
  }

  return merged;
}

/* ========================================================================== *
 * OVERLAP
 * ========================================================================== */

/**
 * Extend a chunk's start backwards into its predecessor.
 *
 * Overlap is produced by moving `charStart`, not by concatenating text — which
 * is what keeps `slice(charStart, charEnd) === text` true for an overlapping
 * chunk exactly as it is for a non-overlapping one.
 *
 * Two rules constrain how far back it reaches:
 *
 *   - It stops at a heading. A section boundary is a real boundary; dragging
 *     the tail of "7.2 Assignment" into the chunk that opens "7.3 Termination"
 *     adds text that is off-topic by construction, and a chunk that BEGINS with
 *     a heading gets no overlap at all.
 *   - It never consumes the predecessor whole. If it did, one chunk would be a
 *     strict superset of another: two vectors for the same passage, both
 *     retrievable, competing for the same slot in the final context.
 *
 * Overlap is whole units, so it lands near the budget rather than on it, and a
 * hard cap of twice the budget keeps "near" from becoming "nowhere near". The
 * case that cap exists for: a predecessor whose last unit is a single
 * 700-token paragraph. Without it, the overlap would take all 700 — appending
 * most of one chunk to the front of the next and roughly doubling its size.
 * Taking no overlap at that boundary is the better answer, and is what happens.
 *
 * The consequence for chunk size is worth stating plainly, because it is the
 * one place a stored chunk can exceed `maxTokens`: the packer budgets the
 * chunk's own content, and overlap is added afterwards. A stored chunk is
 * therefore bounded by `maxTokens + minTokens + 2 * overlapTokens` — the
 * ceiling, plus a possible merge, plus a capped overlap.
 */
function overlapStartFor(
  units: Unit[],
  chunk: Packed,
  previous: Packed,
  overlapTokens: number,
): number {
  if (overlapTokens <= 0) return units[chunk.first].start;
  if (units[chunk.first].isHeading) return units[chunk.first].start;

  const cap = overlapTokens * 2;
  let start = units[chunk.first].start;
  let accumulated = 0;

  // Stop before `previous.first`: at least one unit of the predecessor stays
  // exclusively its own.
  for (let i = previous.last; i > previous.first; i -= 1) {
    const unit = units[i];
    if (unit.isHeading) break;
    if (accumulated + unit.tokens > cap) break;

    start = unit.start;
    accumulated += unit.tokens;
    if (accumulated >= overlapTokens) break;
  }

  return start;
}

/* ========================================================================== *
 * PAGES
 * ========================================================================== */

/**
 * Resolve an offset to a page number.
 *
 * Pages are joined by `PAGE_SEPARATOR`, so there are offsets that fall BETWEEN
 * two pages and belong to neither. Which neighbour to pick depends on which end
 * of the chunk is asking, so the two directions are separate functions rather
 * than one with a flag:
 *
 *   - `pageAtOrAfter` is for `charStart`: the first page whose text has not yet
 *     ended. An offset sitting in a separator resolves FORWARD, to the page the
 *     chunk's content actually begins on.
 *   - `pageAtOrBefore` is for `charEnd - 1`: the last page that has already
 *     begun. An offset in a separator resolves BACKWARD, to the page the
 *     content actually ended on.
 *
 * Both binary search. A 900-page PDF chunks into thousands of chunks, and a
 * linear scan per chunk is quadratic for no reason.
 */
function pageAtOrAfter(pages: readonly PageSpan[], offset: number): number {
  let low = 0;
  let high = pages.length - 1;
  let answer = pages.length - 1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (pages[mid].charEnd > offset) {
      answer = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  return pages[answer].pageNumber;
}

function pageAtOrBefore(pages: readonly PageSpan[], offset: number): number {
  let low = 0;
  let high = pages.length - 1;
  let answer = 0;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (pages[mid].charStart <= offset) {
      answer = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return pages[answer].pageNumber;
}

/* ========================================================================== *
 * ENTRY POINT
 * ========================================================================== */

/**
 * Chunk one document.
 *
 * The pipeline, in order:
 *
 *   blocks   headings and paragraphs, found line by line
 *   units    each block, split down to sentences or characters only as needed
 *   packed   units accumulated greedily up to the token budget
 *   merged   runts absorbed into a neighbour
 *   chunks   overlap applied, offsets resolved to pages, text sliced out
 *
 * COVERAGE. Every non-whitespace character of the document belongs to at least
 * one chunk. It is stated that way, rather than as "the ranges tile the
 * document", because they do not quite: block, sentence, and chunk boundaries
 * are all trimmed, so the whitespace separating two spans belongs to neither of
 * them. Nothing with content is ever dropped — that is the property that
 * matters, and the one the tests assert — but the gaps between ranges are real,
 * and are always blank.
 */
export function chunkDocument(input: ChunkInput): DocumentChunk[] {
  const options = resolveOptions(input.options);
  const { text } = input;

  if (text.trim().length === 0) return [];

  // A document with no pages recorded is treated as a single page. Extraction
  // always produces at least one, so this is a guard rather than a path.
  const pages: readonly PageSpan[] =
    input.pages.length > 0
      ? [...input.pages].sort((a, b) => a.charStart - b.charStart)
      : [{ pageNumber: 1, charStart: 0, charEnd: text.length }];

  const blocks = splitBlocks(text, options);
  const units = buildUnits(text, blocks, options);
  if (units.length === 0) return [];

  const packed = mergeUndersized(packUnits(units, options), options);
  const overlapTokens = Math.round(options.targetTokens * options.overlapRatio);

  return packed.map((chunk, index) => {
    const charStart =
      index === 0
        ? units[chunk.first].start
        : overlapStartFor(units, chunk, packed[index - 1], overlapTokens);
    const charEnd = units[chunk.last].end;
    const chunkText = text.slice(charStart, charEnd);

    const pageFrom = pageAtOrAfter(pages, charStart);

    return {
      ordinal: index,
      text: chunkText,
      // Recounted after overlap: the token count describes the text that is
      // stored and shown, not the text the packer was budgeting.
      tokenCount: options.countTokens(chunkText),
      pageFrom,
      pageTo: Math.max(pageFrom, pageAtOrBefore(pages, charEnd - 1)),
      charStart,
      charEnd,
      sectionPath: sectionPathFor(units, chunk),
    };
  });
}

/**
 * The breadcrumb to record for a packed chunk.
 *
 * Taken from the chunk's first CONTENT unit, not simply its first unit. A chunk
 * usually opens with a run of headings — "# Master Services Agreement", then
 * "## Article 7 - Termination", then "### 7.1 For cause" — and reading the path
 * off the first of those would label the passage "Master Services Agreement",
 * discarding the two levels that make a citation legible. The first line of
 * actual prose is under 7.1, so that is where the chunk is.
 *
 * A chunk that spans a section boundary (see CHUNKING.sectionBreakRatio) is
 * labelled with the section it STARTS in. Some information is lost there and
 * there is no way around it: one chunk gets one path, and the alternative —
 * labelling it with the section it ends in — would be wrong more often, since
 * the bulk of such a chunk is on the leading side of the boundary.
 *
 * The overlap is ignored entirely. It is borrowed context; it does not change
 * which section the passage belongs to.
 */
function sectionPathFor(units: Unit[], chunk: Packed): string | null {
  for (let i = chunk.first; i <= chunk.last; i += 1) {
    if (!units[i].isHeading) return units[i].sectionPath;
  }
  // Headings all the way down: a section title with no body of its own. The
  // deepest one is the most specific thing we know.
  return units[chunk.last].sectionPath;
}
