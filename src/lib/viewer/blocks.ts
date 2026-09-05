import type { TextMatch } from "./search";

/**
 * TURNING STORED PAGE TEXT INTO RENDERABLE BLOCKS — WITHOUT LOSING OFFSETS.
 *
 * This is the module that makes a DOCX read like a document and still behave
 * like one for citations. Every block and every segment it emits carries its
 * offset into the page's own text, so the rendered DOM is addressable by the
 * same coordinates the chunker recorded at ingestion.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE RULE: THE DOM TEXT IS THE STORED TEXT
 *
 * Nothing here rewrites, trims, reflows, or prettifies. Splitting on blank
 * lines is a partition, not a transformation: concatenating every block's text
 * with the separators it was split on reproduces the page byte for byte. That
 * is what lets a citation's `char_start` be resolved to a DOM position by
 * counting characters, with no fuzzy matching anywhere in the path.
 *
 * It is also why paragraphs render with `white-space: pre-wrap` rather than
 * having their internal line breaks collapsed. A Markdown file's hard wraps and
 * a code block's indentation are characters in the stored text; removing them
 * for display would put the DOM and the offsets one space apart per line, and
 * the drift is invisible until a citation lands on the wrong sentence.
 */

/** One paragraph of a page, with where it starts inside that page. */
export interface TextBlock {
  /** Offset into the page's own text. */
  charStart: number;
  text: string;
}

/**
 * Split a page into paragraphs on blank lines.
 *
 * The separator (the blank line itself) is dropped from the blocks and its
 * length is accounted for in the next block's offset, so offsets stay exact.
 */
export function splitBlocks(pageText: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  // Captures the separator so its exact length advances the cursor. A greedy
  // `\n{2,}` is not the same as two newlines, and guessing would drift.
  const parts = pageText.split(/(\n{2,})/);

  let cursor = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    // Odd indices are the captured separators.
    if (index % 2 === 1) {
      cursor += part.length;
      continue;
    }
    if (part.length > 0) blocks.push({ charStart: cursor, text: part });
    cursor += part.length;
  }

  return blocks;
}

/**
 * A run of a block, either plain or part of a search match.
 *
 * `matchIndex` is the position of the match in the DOCUMENT's match list, not
 * this page's — it is what "3 of 47" counts and what next/previous steps
 * through, so it has to survive the trip down to the element that gets marked.
 */
export interface TextSegment {
  text: string;
  /** Offset into the page's own text. */
  charStart: number;
  /** Null for text that is not part of a match. */
  matchIndex: number | null;
}

/**
 * Cut a block into plain and matched segments.
 *
 * Matches arrive as offsets into the PAGE, so they are rebased onto the block
 * here. Matches that span a block boundary — which a whitespace-flexible query
 * can produce across a blank line — are clipped to this block rather than
 * dropped: half a highlight is a better answer than none, and the count
 * already told the reader the match exists.
 */
export function segmentBlock(
  block: TextBlock,
  matches: { match: TextMatch; index: number }[],
): TextSegment[] {
  const blockStart = block.charStart;
  const blockEnd = blockStart + block.text.length;

  const overlapping = matches
    .filter(
      ({ match }) =>
        match.start < blockEnd && match.start + match.length > blockStart,
    )
    .sort((a, b) => a.match.start - b.match.start);

  if (overlapping.length === 0) {
    return [{ text: block.text, charStart: blockStart, matchIndex: null }];
  }

  const segments: TextSegment[] = [];
  let cursor = 0;

  for (const { match, index } of overlapping) {
    const start = Math.max(0, match.start - blockStart);
    const end = Math.min(block.text.length, match.start + match.length - blockStart);

    // Overlapping matches would otherwise emit a negative-length slice. The
    // first one wins; a reader cannot see two highlights on the same word.
    if (end <= cursor) continue;

    if (start > cursor) {
      segments.push({
        text: block.text.slice(cursor, start),
        charStart: blockStart + cursor,
        matchIndex: null,
      });
    }

    segments.push({
      text: block.text.slice(Math.max(cursor, start), end),
      charStart: blockStart + Math.max(cursor, start),
      matchIndex: index,
    });

    cursor = end;
  }

  if (cursor < block.text.length) {
    segments.push({
      text: block.text.slice(cursor),
      charStart: blockStart + cursor,
      matchIndex: null,
    });
  }

  return segments;
}

/**
 * A rough height for a page of text, in CSS pixels, before it has rendered.
 *
 * Used only as the FIRST estimate a virtualised placeholder is given; the real
 * height replaces it the moment the page mounts, and the virtualiser
 * compensates the scroll position when it does. It exists so the scrollbar
 * starts out roughly the right size instead of growing by a factor of thirty
 * as the reader scrolls.
 *
 * The constants are the sheet's own measure: ~78 characters per line at 17px
 * Source Serif in a ~624px column, 28px of line height, and 16px of gap
 * between paragraphs.
 */
export function estimateTextPageHeight(charCount: number, blockCount = 1): number {
  const CHARS_PER_LINE = 78;
  const LINE_HEIGHT = 28;
  const BLOCK_GAP = 16;
  const PAGE_CHROME = 64;

  const lines = Math.max(1, Math.ceil(charCount / CHARS_PER_LINE));
  return lines * LINE_HEIGHT + Math.max(0, blockCount - 1) * BLOCK_GAP + PAGE_CHROME;
}
