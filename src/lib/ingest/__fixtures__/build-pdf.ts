/**
 * A minimal PDF writer, for tests only.
 *
 * The extraction tests need real PDFs — a normal one, a two-column one, a
 * scanned one with no text layer — and checking binary fixtures into the
 * repository would make the interesting part of each case invisible. Building
 * them in code keeps "this page has two text blocks side by side and no text
 * layer" readable, and keeps the test suite free of opaque blobs.
 *
 * The output is a genuine PDF: object offsets in the cross-reference table are
 * computed from the real byte positions, which is the part PDF.js actually
 * validates. Everything is written as latin1, so one character is one byte and
 * string offsets are byte offsets.
 */

export interface PdfTextBlock {
  /** PDF user space, origin bottom-left. */
  x: number;
  y: number;
  lines: string[];
}

export interface PdfPageSpec {
  /** A page with no blocks produces an empty content stream — a "scanned" page. */
  blocks: PdfTextBlock[];
}

const FONT_SIZE = 11;
const LEADING = 14;

/** `(`, `)` and `\` are the only characters that need escaping in a PDF string. */
function escapePdfString(value: string): string {
  return value.replace(/[\\()]/g, (match) => `\\${match}`);
}

function contentStreamFor(page: PdfPageSpec): string {
  return page.blocks
    .map((block) => {
      const shown = block.lines
        .map((line, index) =>
          index === 0
            ? `(${escapePdfString(line)}) Tj`
            : `T* (${escapePdfString(line)}) Tj`,
        )
        .join("\n");
      return [
        "BT",
        `/F1 ${FONT_SIZE} Tf`,
        `${LEADING} TL`,
        `${block.x} ${block.y} Td`,
        shown,
        "ET",
      ].join("\n");
    })
    .join("\n");
}

export interface BuildPdfOptions {
  /**
   * Add a standard security-handler dictionary whose /U hash matches no
   * password, which is how a password-protected PDF presents itself to a
   * parser. Used to exercise the encrypted-file path.
   */
  encrypted?: boolean;
  /** Emit a Pages tree with no kids, for the zero-page guard. */
  noPages?: boolean;
}

export function buildPdf(
  pages: PdfPageSpec[],
  options: BuildPdfOptions = {},
): Uint8Array {
  const pageCount = options.noPages ? 0 : pages.length;

  // Object numbering: 1 catalog, 2 pages tree, then one object per page, then
  // one content stream per page, then the font, then optionally /Encrypt.
  const firstPageObject = 3;
  const firstContentObject = firstPageObject + pageCount;
  const fontObject = firstContentObject + pageCount;
  const encryptObject = fontObject + 1;

  const bodies: string[] = [];

  bodies.push("<< /Type /Catalog /Pages 2 0 R >>");

  const kids = Array.from(
    { length: pageCount },
    (_unused, index) => `${firstPageObject + index} 0 R`,
  ).join(" ");
  bodies.push(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`);

  for (let index = 0; index < pageCount; index += 1) {
    bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${fontObject} 0 R >> >> ` +
        `/Contents ${firstContentObject + index} 0 R >>`,
    );
  }

  for (let index = 0; index < pageCount; index += 1) {
    const stream = contentStreamFor(pages[index]);
    bodies.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }

  bodies.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  if (options.encrypted) {
    // 32 arbitrary bytes each. A parser derives the key from the empty user
    // password, compares it with /U, fails, and asks for a password.
    const filler = "A1".repeat(32);
    bodies.push(
      `<< /Filter /Standard /V 2 /R 3 /Length 128 /P -1 ` +
        `/O <${filler}> /U <${filler}> >>`,
    );
  }

  // %PDF header, then a comment of high bytes marking the file as binary.
  let pdf = "%PDF-1.7\n%âãÏÓ\n";
  const offsets: number[] = [];

  bodies.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = pdf.length;
  const size = bodies.length + 1;

  // Every cross-reference entry is exactly 20 bytes: a 10-digit offset, a
  // space, a 5-digit generation, a space, the type, and a two-byte terminator.
  pdf += `xref\n0 ${size}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }

  const trailerEntries = [`/Size ${size}`, "/Root 1 0 R"];
  if (options.encrypted) {
    trailerEntries.push(`/Encrypt ${encryptObject} 0 R`);
    trailerEntries.push(`/ID [<${"0".repeat(32)}> <${"0".repeat(32)}>]`);
  }

  pdf += `trailer\n<< ${trailerEntries.join(" ")} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(pdf, "latin1"));
}

/** A PDF header followed by nonsense — a damaged file, not a foreign one. */
export function buildCorruptPdf(): Uint8Array {
  return new Uint8Array(
    Buffer.from("%PDF-1.7\nthis is not a cross-reference table\n", "latin1"),
  );
}
