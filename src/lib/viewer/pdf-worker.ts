import { pdfjs } from "react-pdf";

/**
 * THE PDF.js RUNTIME ASSETS.
 *
 * PDF.js parses and rasterises in a Web Worker. Without one it falls back to
 * "fake worker" mode on the main thread, which locks the tab solid on anything
 * larger than a few pages — so this is not optional configuration, it is the
 * difference between a viewer and a freeze.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THE WORKER IS COPIED INTO public/ RATHER THAN BUNDLED
 *
 * The idiomatic bundler move is:
 *
 *     new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url)
 *
 * which asks the bundler to emit the worker as a static asset and hand back its
 * hashed URL. Under Turbopack that expression resolves at build time against
 * the module's own location, and the emitted asset is what the browser then
 * fetches. It works — but its failure mode is the worst kind: if the bundler
 * ever treats the file as a MODULE to be transformed rather than an ASSET to be
 * copied, the URL still resolves, the fetch still returns 200, and the worker
 * fails to start at the first PDF. That is a runtime failure in a production
 * deployment that no build step reports.
 *
 * So the worker is copied verbatim into `public/pdfjs/` by
 * `scripts/copy-pdf-worker.mjs`, which runs on `predev` and `prebuild`. Three
 * properties follow, and each of them is why this is worth a build step:
 *
 *   - THE FILE IS THE FILE. It is a byte-for-byte copy of the worker shipped in
 *     `pdfjs-dist`, served as-is. No transform runs over it, so there is no
 *     version of this that "builds fine and breaks in production".
 *   - THE URL IS FIXED AND CHECKABLE. `/pdfjs/pdf.worker.min.mjs` is a real
 *     path a production build can be tested against with a single HTTP
 *     request, rather than a hash you have to dig out of a chunk to verify.
 *   - THE VERSION CANNOT DRIFT. The copy script fails the build if the file is
 *     missing, and rewrites it on every build from the installed package, so a
 *     `pdfjs-dist` upgrade cannot leave a stale worker behind. A mismatched
 *     worker and API throw `The API version does not match the Worker version`
 *     at the first page, which is exactly the class of bug this avoids.
 *
 * The copied file is gitignored: it is build output, reproduced from a pinned
 * dependency, and committing it would be committing a second copy of a
 * dependency that can then disagree with the first.
 */

/** Everything PDF.js loads at runtime, served from `public/pdfjs/`. */
const PDFJS_ASSET_ROOT = "/pdfjs/";

/**
 * Root-relative, so all three resolve the same under `next dev`, `next start`,
 * and a Vercel deployment.
 */
export const PDF_WORKER_SRC = `${PDFJS_ASSET_ROOT}pdf.worker.min.mjs`;

/**
 * Character maps and the 14 base fonts.
 *
 * PDF.js fetches these lazily, only for documents that need them — a CJK
 * encoding, or a file that references Helvetica without embedding it. Without
 * them those documents render as blank pages with a selectable but empty text
 * layer, which looks exactly like a document with no text rather than like a
 * missing asset.
 *
 * Passed as `<Document options>`, which must be a stable reference or react-pdf
 * reloads the file on every render — hence the frozen constant.
 */
export const PDF_OPTIONS = Object.freeze({
  cMapUrl: `${PDFJS_ASSET_ROOT}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${PDFJS_ASSET_ROOT}standard_fonts/`,
});

/**
 * Point PDF.js at the worker. Idempotent, and safe to call from any client
 * component that is about to render a page — `GlobalWorkerOptions` is a
 * module-level singleton, so the assignment happens once per document.
 */
export function configurePdfWorker(): void {
  if (pdfjs.GlobalWorkerOptions.workerSrc === PDF_WORKER_SRC) return;
  pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
}
