import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

/**
 * Copy the PDF.js runtime assets out of `pdfjs-dist` and into `public/pdfjs/`.
 *
 * Runs on `predev` and `prebuild`, so the copies are regenerated from the
 * installed package on every build and can never fall behind a dependency
 * upgrade. A worker whose version does not match the PDF.js API throws
 * "The API version does not match the Worker version" at the first page render
 * — a runtime failure in production that no build step would otherwise catch.
 *
 * Three things are copied, and each is a class of blank-page bug avoided:
 *
 *   pdf.worker.min.mjs  Parsing and rasterisation. Without it PDF.js falls
 *                       back to doing that on the main thread, which locks the
 *                       tab on anything past a few pages.
 *   cmaps/              Character maps for CJK and other non-Latin encodings.
 *                       Missing, those documents render as blank pages with a
 *                       selectable but empty text layer.
 *   standard_fonts/     The 14 PDF base fonts. Plenty of ordinary contracts
 *                       reference Helvetica or Times without embedding them.
 *
 * The copies are gitignored: they are build output reproduced from a pinned
 * dependency, and committing them would create a second copy that can then
 * disagree with the first.
 *
 * This script FAILS THE BUILD if the assets cannot be found. A viewer deployed
 * without them is worse than one that was not deployed.
 */

const require = createRequire(import.meta.url);

/** Copied verbatim, preserving the directory names PDF.js expects in a URL. */
const ASSETS = [
  { from: "build/pdf.worker.min.mjs", to: "pdf.worker.min.mjs" },
  { from: "cmaps", to: "cmaps" },
  { from: "standard_fonts", to: "standard_fonts" },
];

async function main() {
  const packageJsonPath = require.resolve("pdfjs-dist/package.json");
  const packageRoot = path.dirname(packageJsonPath);
  const version = JSON.parse(await readFile(packageJsonPath, "utf8")).version;

  const destinationRoot = path.join(process.cwd(), "public", "pdfjs");

  // Removed first, so an asset dropped by an upgrade does not linger and get
  // served alongside the new ones.
  await rm(destinationRoot, { recursive: true, force: true });
  await mkdir(destinationRoot, { recursive: true });

  for (const asset of ASSETS) {
    await cp(
      path.join(packageRoot, asset.from),
      path.join(destinationRoot, asset.to),
      { recursive: true },
    );
  }

  console.log(`[pdf] pdfjs-dist ${version} assets copied to public/pdfjs/`);
}

main().catch((error) => {
  console.error(
    "[pdf] could not copy the PDF.js runtime assets. The document viewer " +
      "cannot work without them, so this is a build failure rather than a " +
      "warning.",
    error,
  );
  process.exit(1);
});
