import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE EVAL CORPUS: fetching, converting, and pinning it.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THE TEXT IS COMMITTED AND THE FETCHER IS STILL HERE
 *
 * The converted `.txt` files are checked into the repository. That is what
 * makes this harness OFFLINE: `npm run eval` reads bytes from disk, so a run
 * today and a run in a year measure the same corpus, and a retrieval change
 * shows up as a delta rather than as "did the source page get reworded?".
 * An eval whose dataset can move under it is not a measurement.
 *
 * The fetcher exists for the other half of that promise: it proves the
 * committed text is what the cited source actually says. `npm run eval:fetch`
 * re-downloads every document, re-converts it, and checks the result against
 * the sha256 in the manifest. A mismatch is not automatically a problem — a
 * regulation genuinely gets amended — but it is something you have to look at
 * and then pin deliberately with `--update`, rather than something that
 * silently changes the score.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY PLAIN TEXT AND NOT THE ORIGINAL PDF/HTML
 *
 * Because the question set is written against character offsets and page
 * numbers, and those have to be stable. Converting once, committing the
 * result, and hashing it means the corpus is a fixed artefact. Converting on
 * every run — with a PDF parser, or an HTML-to-text pass whose output depends
 * on a website's markup — would let a dependency upgrade move every page
 * number in `questions.jsonl` without anyone touching the file.
 *
 * The cost is that this eval does not exercise PDF extraction. That is a real
 * gap and it is named in evals/README.md rather than papered over.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EVALS_DIR = path.resolve(HERE, "..");
export const DATASET_DIR = path.join(EVALS_DIR, "dataset");
export const MANIFEST_PATH = path.join(DATASET_DIR, "manifest.json");

export interface DatasetDocument {
  id: string;
  title: string;
  kind: string;
  url: string;
  format: "ecfr-xml" | "cdc-mmwr-html" | "nist-html";
  filename: string;
  license: string;
  /** sha256 of the CONVERTED text, hex. "PENDING" before the first pin. */
  sha256: string;
}

export interface Manifest {
  note: string[];
  documents: DatasetDocument[];
}

export async function readManifest(): Promise<Manifest> {
  return JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as Manifest;
}

/** The committed text of one corpus document. */
export async function readDatasetText(
  document: DatasetDocument,
): Promise<string> {
  return readFile(path.join(DATASET_DIR, document.filename), "utf8");
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/* ========================================================================== *
 * CONVERSION
 * ========================================================================== */

/**
 * eCFR's XML rendering of a regulation, as readable text.
 *
 * The schema is shallow and stable: `DIV3`…`DIV8` nest the hierarchy, `HEAD`
 * carries each level's heading, and `P`/`PSPACE`/`FP` carry the prose. So the
 * conversion is a tag walk rather than a general XML-to-text pass — headings
 * are kept on their own line, which is exactly what the chunker's
 * structure-first splitting needs to produce section breadcrumbs.
 *
 * A general "strip all tags" would flatten the headings into the paragraph
 * before them, and every chunk in the corpus would lose its `section_path`.
 * That would not fail; it would just quietly make the whole eval measure a
 * worse pipeline than the one that runs in production.
 */
function fromEcfrXml(xml: string): string {
  const out: string[] = [];

  // Headings and prose, in document order. Both tag families are matched in
  // one pass so their interleaving is preserved.
  const pattern =
    /<(HEAD|SUBJECT|P|PSPACE|FP|CITA|EDNOTE|HED)\b[^>]*>([\s\S]*?)<\/\1>/g;

  for (const match of xml.matchAll(pattern)) {
    const tag = match[1];
    const text = decodeEntities(stripTags(match[2])).trim();
    if (!text) continue;

    // A heading gets a blank line before it and stands alone, so the chunker
    // sees a structural boundary rather than a long line of prose.
    if (tag === "HEAD" || tag === "SUBJECT" || tag === "HED") {
      out.push("", text, "");
    } else {
      out.push(text, "");
    }
  }

  return normalise(out.join("\n"));
}

/**
 * A CDC MMWR article, as readable text.
 *
 * MMWR pages wrap the article in `<div class="syndicate">`; everything outside
 * it is site chrome — navigation, breadcrumbs, the alert banner, the footer.
 * Including that would put the same 400 words of menu text at the top of the
 * document, where it would be chunked, embedded, and retrieved as if it were
 * content. On a three-document corpus that is enough to distort recall.
 *
 * Tables are dropped rather than flattened. MMWR's recommendation tables are
 * layout-heavy, and a flattened one becomes a run of disconnected numbers that
 * matches many queries weakly and none of them well — a retrieval liability
 * with no answer in it. The prose recommendations they summarise are kept.
 */
function fromCdcHtml(html: string): string {
  // Everything the article is not.
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<table[\s\S]*?<\/table>/gi, " ")
    .replace(/<figure[\s\S]*?<\/figure>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ");

  // The article proper, when the wrapper is present.
  const syndicate = body.match(
    /<div[^>]*class="[^"]*syndicate[^"]*"[^>]*>([\s\S]*)<\/div>/i,
  );
  if (syndicate) body = syndicate[1];

  // Headings and block elements become line breaks; everything else collapses.
  body = body
    .replace(/<\/(h[1-6]|p|li|div|section|article|br)\s*>/gi, "\n")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<h[1-6][^>]*>/gi, "\n\n");

  return normalise(decodeEntities(stripTags(body)));
}

/**
 * A NIST Special Publication, as readable text — TABLES INCLUDED.
 *
 * The one document in this corpus that is mostly tables: authenticator types
 * against verifier requirements, assurance levels against permitted methods.
 * Dropping them, as the MMWR converter does, would throw away the reason this
 * document is here — a corpus of three prose documents does not show whether
 * retrieval can answer "which authenticators are allowed at AAL2".
 *
 * Each row becomes one line of pipe-delimited cells, and the header row is
 * repeated as the first line. That shape is chosen for the CHUNKER: a row is a
 * complete thought on one line, so a chunk boundary lands between rows rather
 * than mid-table, and the header travels with the rows in the same chunk often
 * enough to keep the cells interpretable. Flattening to prose instead — "the
 * value for AAL2 is X" — would be inventing sentences the document does not
 * contain, which is exactly what a grounded-answer product must not do.
 */
function fromNistHtml(html: string): string {
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    /*
     * THE RENDER TIMESTAMP.
     *
     * This page carries a bare `<p>Sun, 06 Sep 2026 04:03:31 +0000</p>` — the
     * moment the static site was built, not a fact about the document. Left in,
     * it makes the converted text different on every fetch, so the sha256 pin
     * reports drift forever and the one signal that would catch a real
     * amendment becomes noise. Dropped by shape rather than by value: any
     * paragraph whose entire content is an RFC-2822 date.
     */
    .replace(
      /<p>\s*[A-Z][a-z]{2},\s+\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+[+-]\d{4}\s*<\/p>/g,
      " ",
    );

  // Tables first, before the generic tag strip flattens them into a run of
  // disconnected words with no row boundaries left to recover.
  body = body.replace(/<table[\s\S]*?<\/table>/gi, (table) => {
    const rows: string[] = [];

    for (const match of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...match[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map((cell) => decodeEntities(stripTags(cell[1])).replace(/\s+/g, " ").trim())
        .filter((cell) => cell.length > 0);

      if (cells.length > 0) rows.push(cells.join(" | "));
    }

    // A blank line either side so the chunker treats the table as its own
    // structural unit rather than gluing it to the paragraph above.
    return rows.length > 0 ? `\n\n${rows.join("\n")}\n\n` : " ";
  });

  body = body
    .replace(/<\/(h[1-6]|p|li|div|section|article|br)\s*>/gi, "\n")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<h[1-6][^>]*>/gi, "\n\n");

  return normalise(decodeEntities(stripTags(body)));
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, " ");
}

/**
 * Named and numeric entities, decoded.
 *
 * NOT cosmetic. An undecoded `&ndash;` survives tokenisation as the literal
 * characters `& n d a s h ;`, and this corpus contains 394 of them — enough
 * that "&ndash;" becomes a frequent term in the lexical index and a
 * meaningless component of many embeddings. `&ge;18 years` is worse: the
 * clinical guideline's own scope statement stops containing the concept
 * "18 years or older" in any form a query can match.
 *
 * The table is the entities these two sources actually emit, established by
 * grepping the converted output rather than by copying a full HTML5 list.
 * Anything unmatched is LEFT ALONE rather than stripped, so a new entity shows
 * up in the text as itself — visible, greppable, and fixable — instead of
 * silently vanishing from a passage.
 */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  ge: "≥",
  le: "≤",
  minus: "−",
  plusmn: "±",
  times: "×",
  micro: "µ",
  deg: "°",
  reg: "®",
  copy: "©",
  trade: "™",
  sect: "§",
  para: "¶",
  bull: "•",
  dagger: "†",
  Dagger: "‡",
  iuml: "ï",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  ccedil: "ç",
  ntilde: "ñ",
  aacute: "á",
  oacute: "ó",
  iacute: "í",
  uacute: "ú",
  szlig: "ß",
  oslash: "ø",
  aring: "å",
};

function decodeEntities(value: string): string {
  return (
    value
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
        String.fromCodePoint(Number.parseInt(hex, 16)),
      )
      .replace(/&#(\d+);/g, (_, dec) =>
        String.fromCodePoint(Number.parseInt(dec, 10)),
      )
      // One pass over the named table. `&amp;` is in it, and being part of the
      // same pass is what stops a double-encoded `&amp;ndash;` from becoming a
      // real en dash — it decodes to `&ndash;` and stays there, visibly wrong,
      // rather than being quietly repaired into something the source did not
      // say.
      .replace(/&([a-zA-Z][a-zA-Z0-9]{1,9});/g, (whole, name: string) =>
        name in NAMED_ENTITIES ? NAMED_ENTITIES[name] : whole,
      )
  );
}

/**
 * One canonical shape for every document.
 *
 * Line endings, non-breaking spaces, and runs of blank lines are all
 * normalised here rather than in each converter, because they are what the
 * sha256 is taken over. A corpus whose hash changes when a source switches
 * from CRLF to LF would report drift that is not drift.
 */
function normalise(text: string): string {
  return `${text
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}

export function convert(document: DatasetDocument, raw: string): string {
  switch (document.format) {
    case "ecfr-xml":
      return fromEcfrXml(raw);
    case "cdc-mmwr-html":
      return fromCdcHtml(raw);
    case "nist-html":
      return fromNistHtml(raw);
  }
}
