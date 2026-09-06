"use client";

/**
 * FROM A CHARACTER RANGE TO PIXELS ON THE PAGE.
 *
 * `locatePassage` answers "where in this page's text is the quote". This turns
 * that answer into rectangles the highlighter can paint, and it is the one
 * place the two renderers converge in the DOM:
 *
 *   - a PDF page's text lives in PDF.js's text layer, one absolutely
 *     positioned span per text item, transparent, sitting over the canvas;
 *   - a text page's text lives in our own paragraphs.
 *
 * Both are text nodes under an element carrying `data-viewer-page`. Walking
 * them produces one string and a map back to (node, offset), and from there a
 * DOM `Range` — which knows how to report its own geometry through
 * `getClientRects()` whatever produced it. Transforms, page scaling, and the
 * per-span `scaleX` PDF.js applies are all handled by the browser rather than
 * re-derived here.
 */

/** PDF.js appends this to the text layer to make selection work past the end. */
const IGNORED_SELECTORS = ".endOfContent, [data-viewer-ignore]";

export interface TextSource {
  /** Every text node's data, concatenated in document order. */
  text: string;
  nodes: { node: Text; start: number }[];
}

/**
 * Concatenate the text of these page elements, WITH NO SEPARATOR.
 *
 * Nothing is inserted between nodes, and that is deliberate. PDF.js splits a
 * line into several spans at every font change, so "sixty (60)" can arrive as
 * two spans with no space between them — inserting one would invent a
 * character. At a line end the opposite is true and a space is missing. There
 * is no separator that is right for both, which is exactly why matching
 * removes whitespace on both sides instead. See `passage.ts`.
 */
export function collectText(roots: Element[]): TextSource {
  const nodes: { node: Text; start: number }[] = [];
  const parts: string[] = [];
  let cursor = 0;

  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest(IGNORED_SELECTORS)) return NodeFilter.FILTER_REJECT;
        return (node as Text).data.length > 0
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });

    let node = walker.nextNode() as Text | null;
    while (node) {
      nodes.push({ node, start: cursor });
      parts.push(node.data);
      cursor += node.data.length;
      node = walker.nextNode() as Text | null;
    }
  }

  return { text: parts.join(""), nodes };
}

/** Build a DOM Range over `[start, end)` of the collected text. */
export function rangeFor(
  source: TextSource,
  start: number,
  end: number,
): Range | null {
  const from = locate(source, start);
  // The end is exclusive, so it is looked up as the position AFTER the last
  // character — which may be the very end of a node rather than inside one.
  const to = locate(source, end, true);
  if (!from || !to) return null;

  const range = document.createRange();
  try {
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
  } catch {
    // The DOM moved under us — a page unmounted mid-resolution. The caller
    // retries on the next render rather than painting a stale range.
    return null;
  }
  return range;
}

function locate(
  source: TextSource,
  index: number,
  atEnd = false,
): { node: Text; offset: number } | null {
  for (let i = 0; i < source.nodes.length; i += 1) {
    const entry = source.nodes[i];
    const length = entry.node.data.length;
    const relative = index - entry.start;

    if (relative < 0) return null;
    if (relative < length || (atEnd && relative === length)) {
      return { node: entry.node, offset: relative };
    }
  }
  return null;
}

export interface Band {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The rectangles to paint, relative to `origin`, merged into one band per line.
 *
 * `getClientRects()` returns one rectangle per line box — and for a PDF, one
 * per SPAN, so a single line broken by a font change comes back as several
 * touching rectangles. Painting them unmerged produces a highlight with seams
 * in it wherever the document changed weight, which reads as a rendering bug.
 *
 * Rectangles are grouped by vertical position and merged when they touch or
 * nearly touch horizontally. A large horizontal gap is left as a gap, because
 * on a two-column page that is a real one.
 */
export function bandRects(range: Range, origin: DOMRect): Band[] {
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0.5 && rect.height > 0.5,
  );
  if (rects.length === 0) return [];

  const lines: DOMRect[][] = [];
  for (const rect of [...rects].sort((a, b) => a.top - b.top || a.left - b.left)) {
    const line = lines[lines.length - 1];
    const previous = line?.[0];
    // Same line when the vertical centres are within half a line height. That
    // tolerates the sub-pixel differences between spans of different sizes on
    // one line without merging two real lines.
    const sameLine =
      previous !== undefined &&
      Math.abs(centre(rect) - centre(previous)) < Math.min(rect.height, previous.height) * 0.5;

    if (sameLine) line.push(rect);
    else lines.push([rect]);
  }

  const bands: Band[] = [];
  for (const line of lines) {
    const sorted = line.sort((a, b) => a.left - b.left);
    let current = sorted[0];

    for (let i = 1; i < sorted.length; i += 1) {
      const next = sorted[i];
      // 4px closes the gap a font change leaves; a column gutter is far wider.
      if (next.left - (current.left + current.width) <= 4) {
        const right = Math.max(current.left + current.width, next.left + next.width);
        const top = Math.min(current.top, next.top);
        const bottom = Math.max(current.bottom, next.bottom);
        current = new DOMRect(current.left, top, right - current.left, bottom - top);
      } else {
        bands.push(toBand(current, origin));
        current = next;
      }
    }
    bands.push(toBand(current, origin));
  }

  return bands;
}

function centre(rect: DOMRect): number {
  return rect.top + rect.height / 2;
}

function toBand(rect: DOMRect, origin: DOMRect): Band {
  return {
    left: rect.left - origin.left,
    top: rect.top - origin.top,
    width: rect.width,
    height: rect.height,
  };
}
