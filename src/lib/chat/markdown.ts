/**
 * A SMALL MARKDOWN PARSER, FOR ANSWERS ONLY.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY NOT A LIBRARY
 *
 * Three reasons, in order of weight:
 *
 *   1. THE COLOUR LAW. Every markdown renderer worth using ships with — or
 *      expects — a syntax-highlighting theme, and every one of those themes is
 *      a palette. In this application colour means citation and nothing else,
 *      so a code block that renders keywords in purple is not a styling
 *      preference; it is a design system violation that arrives by default.
 *   2. CITATION MARKERS ARE PART OF THE GRAMMAR. `[3]` has to become a React
 *      element carrying a document's ink, inline, mid-sentence. Every library
 *      makes that a plugin or a post-pass over rendered HTML.
 *   3. THE INPUT IS NARROW. Answers are short grounded prose: paragraphs,
 *      lists, the occasional table, bold for emphasis. The parser below covers
 *      what the system prompt actually asks for.
 *
 * It emits a TOKEN TREE, not HTML and not React. That keeps it pure, keeps it
 * testable in the Node test environment alongside the rest of the retrieval
 * code, and means the renderer decides every element and every class — which
 * is what makes points 1 and 2 hold.
 *
 * NOTHING HERE PRODUCES MARKUP, so there is no HTML injection surface. The one
 * value that reaches an attribute is a link href, and `safeHref` is the gate.
 */

export type Inline =
  | { kind: "text"; value: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "code"; value: string }
  | { kind: "link"; href: string; children: Inline[] }
  /** A citation marker: `[3]`. Rendered as a chip in the source's ink. */
  | { kind: "marker"; marker: number };

export interface ListItem {
  inline: Inline[];
  /** A nested list, hung under the item that opened it. */
  children: Block[];
}

export type TableAlign = "left" | "center" | "right";

export type Block =
  | { kind: "paragraph"; inline: Inline[] }
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; inline: Inline[] }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "code"; language: string | null; value: string }
  | { kind: "table"; head: Inline[][]; rows: Inline[][][]; align: TableAlign[] }
  | { kind: "rule" };

/* ========================================================================== *
 * INLINE
 * ========================================================================== */

/**
 * The inline grammar, as one alternation. ORDER IS THE SPECIFICATION:
 *
 *   code   — first, so backticks quarantine everything inside them
 *   marker — `[3]` NOT followed by `(`, so it can never eat a link
 *   link   — `[text](href)`
 *   strong — before emphasis, or the emphasis branch wins the first asterisk
 *   em     — single asterisks
 *
 * UNDERSCORES ARE NOT EMPHASIS. `_` is left literal because the documents this
 * application reads are full of identifiers — `char_start`, `page_from`, part
 * numbers like `ZX_4471_Q` — and italicising the middle of one silently
 * corrupts a quoted term. Asterisks are unambiguous enough to keep.
 */
const INLINE =
  /(`+)([\s\S]*?)\1|\[([1-9]\d*)\](?!\()|\[([^\]\n]*)\]\(([^)\s]+)\)|\*\*([\s\S]+?)\*\*|\*([^*\n]+)\*/g;

/**
 * Links are restricted to http, https, mailto, and same-document references.
 *
 * The answer text is model output. A `javascript:` or `data:` URL in an href is
 * the one place a token tree can still become an execution surface, and an
 * allowlist is the only reliable way to close it — a denylist of schemes loses
 * to whitespace, casing, and control characters.
 */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (/^(https?:|mailto:)/i.test(href)) return href;
  // A bare path or fragment cannot carry a scheme, so it is safe as written.
  if (/^[/#]/.test(href)) return href;
  return null;
}

export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let cursor = 0;

  const pushText = (value: string) => {
    if (!value) return;
    const last = out[out.length - 1];
    if (last?.kind === "text") last.value += value;
    else out.push({ kind: "text", value });
  };

  // `matchAll` clones the regex before iterating, so `lastIndex` is per-call.
  // That matters because this function RECURSES into the contents of every
  // strong, emphasis, and link node: sharing one stateful global regex across
  // those calls means a nested parse rewinds its parent's scan position, and
  // the parent then re-matches the same span forever.
  for (const match of source.matchAll(INLINE)) {
    pushText(source.slice(cursor, match.index));
    cursor = match.index + match[0].length;

    const code = match[2];
    const marker = match[3];
    const linkText = match[4];
    const linkHref = match[5];
    const strong = match[6];
    const em = match[7];

    if (code !== undefined) {
      // A code span is literal all the way down; never re-parsed.
      out.push({ kind: "code", value: code.trim() });
    } else if (marker !== undefined) {
      out.push({ kind: "marker", marker: Number(marker) });
    } else if (linkHref !== undefined) {
      const href = safeHref(linkHref);
      if (href) {
        out.push({ kind: "link", href, children: parseInline(linkText ?? "") });
      } else {
        // Refused, but not deleted: the reader still sees what was written.
        pushText(match[0]);
      }
    } else if (strong !== undefined) {
      out.push({ kind: "strong", children: parseInline(strong) });
    } else if (em !== undefined) {
      out.push({ kind: "em", children: parseInline(em) });
    }
  }

  pushText(source.slice(cursor));
  return out;
}

/* ========================================================================== *
 * BLOCKS
 * ========================================================================== */

const HEADING = /^(#{1,6})\s+(.*)$/;
const UNORDERED = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE = /^\s*```(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
/** A table delimiter row: `| --- | :--: | ---: |`. */
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** Split a pipe-table row, dropping the leading and trailing pipes. */
function splitRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|")) body = body.slice(0, -1);
  return body.split("|").map((cell) => cell.trim());
}

function alignOf(cell: string): TableAlign {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return "left";
}

/**
 * Parse an answer into blocks.
 *
 * Called on every streaming delta, so it is a single forward pass over the
 * lines with no backtracking. A half-written `**bold` at the stream's edge
 * renders as literal text until its closer arrives; that flicker is cheaper
 * than buffering the answer and showing nothing until it completes.
 */
export function parseMarkdown(source: string): Block[] {
  return parseBlocks(source.replace(/\r\n?/g, "\n").split("\n"));
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    /* --- fenced code ----------------------------------------------------- */
    const fence = FENCE.exec(line);
    if (fence) {
      const language = fence[1].trim() || null;
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      // An unterminated fence still closes the block: mid-stream, the closing
      // backticks simply have not arrived yet.
      index += 1;
      blocks.push({ kind: "code", language, value: body.join("\n") });
      continue;
    }

    /* --- horizontal rule -------------------------------------------------- */
    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }

    /* --- heading ---------------------------------------------------------- */
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        inline: parseInline(heading[2].trim()),
      });
      index += 1;
      continue;
    }

    /* --- blockquote ------------------------------------------------------- */
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index])) {
        body.push(QUOTE.exec(lines[index])![1]);
        index += 1;
      }
      blocks.push({ kind: "quote", blocks: parseBlocks(body) });
      continue;
    }

    /* --- table ------------------------------------------------------------ */
    if (
      line.includes("|") &&
      index + 1 < lines.length &&
      lines[index + 1].includes("-") &&
      TABLE_DELIMITER.test(lines[index + 1])
    ) {
      const head = splitRow(line);
      const align = splitRow(lines[index + 1]).map(alignOf);
      index += 2;

      const rows: Inline[][][] = [];
      while (
        index < lines.length &&
        lines[index].includes("|") &&
        lines[index].trim() !== ""
      ) {
        rows.push(splitRow(lines[index]).map(parseInline));
        index += 1;
      }

      blocks.push({ kind: "table", head: head.map(parseInline), align, rows });
      continue;
    }

    /* --- list ------------------------------------------------------------- */
    const unordered = UNORDERED.exec(line);
    const ordered = ORDERED.exec(line);
    if (unordered ?? ordered) {
      const isOrdered = ordered !== null && unordered === null;
      const start = isOrdered ? Number(ordered![2]) : 1;
      // The indentation of the first marker defines this list's level.
      const baseIndent = (isOrdered ? ordered![1] : unordered![1]).length;
      const items: ListItem[] = [];

      while (index < lines.length) {
        const current = lines[index];
        if (current.trim() === "") break;

        const u = UNORDERED.exec(current);
        const o = ORDERED.exec(current);
        if (!u && !o) break;

        const indent = (u ? u[1] : o![1]).length;
        if (indent < baseIndent) break;

        if (indent > baseIndent) {
          // Nested. Collect the whole indented run, dedent it, and parse it
          // recursively under the item that opened it.
          const nested: string[] = [];
          while (index < lines.length) {
            const inner = lines[index];
            const iu = UNORDERED.exec(inner);
            const io = ORDERED.exec(inner);
            if (!iu && !io) break;
            if ((iu ? iu[1] : io![1]).length <= baseIndent) break;
            nested.push(inner.slice(baseIndent + 1));
            index += 1;
          }
          const owner = items[items.length - 1];
          if (owner) owner.children.push(...parseBlocks(nested));
          continue;
        }

        // A marker of the other kind at the same indent starts a new list.
        const currentIsOrdered = o !== null && u === null;
        if (currentIsOrdered !== isOrdered) break;

        items.push({
          inline: parseInline((u ? u[3] : o![3]).trim()),
          children: [],
        });
        index += 1;
      }

      blocks.push({ kind: "list", ordered: isOrdered, start, items });
      continue;
    }

    /* --- paragraph ---------------------------------------------------------
     * Runs until a blank line or the start of any other block. Soft line
     * breaks inside it are joined with a space, which is how markdown reads and
     * how a model's hard-wrapped output is meant to be shown.
     */
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index];
      if (
        current.trim() === "" ||
        HEADING.test(current) ||
        RULE.test(current) ||
        FENCE.test(current) ||
        QUOTE.test(current) ||
        UNORDERED.test(current) ||
        ORDERED.test(current)
      ) {
        break;
      }
      paragraph.push(current.trim());
      index += 1;
    }

    blocks.push({ kind: "paragraph", inline: parseInline(paragraph.join(" ")) });
  }

  return blocks;
}

/**
 * Remove citation markers the model invented.
 *
 * The same job `stripMarkers` does in src/lib/llm/citations.ts, repeated on the
 * client for one reason: validation runs on the COMPLETE answer, but the deltas
 * carrying a bad marker have already been rendered by then. Without this, the
 * live view would show `[9]` and a reload would not — which reads as a
 * rendering bug rather than what it is: a marker that resolved to no source.
 */
export function stripInvalidMarkers(text: string, invalid: number[]): string {
  if (invalid.length === 0) return text;
  const drop = new Set(invalid);
  return text
    .replace(/\[([1-9]\d*)\]/g, (match, digits: string) =>
      drop.has(Number(digits)) ? "" : match,
    )
    .replace(/[ \t]+([.,;:!?)\]])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .trim();
}
