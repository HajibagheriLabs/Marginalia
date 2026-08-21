import type { PlaceholderPage } from "@/lib/placeholder";

/**
 * SCAFFOLDING — DELETE WHEN THE PDF VIEWER LANDS.
 *
 * A stand-in for rendered document text, so the reading experience can be
 * judged before there is anything real to read: 17px Source Serif 4 at 1.65,
 * one heading weight, and generous margins setting the measure.
 *
 * Note what is NOT here: no colour. A real page gets highlight bands when
 * passages are cited, and those bands are the only colour that will ever appear
 * on paper. An uncited page is black text on warm white and nothing else.
 */
export function PlaceholderPageContent({ page }: { page: PlaceholderPage }) {
  return (
    <>
      {/* The heading breadcrumb — the chunk's section_path, once chunking is
          real. Small, uppercase, and in the paper's muted tone. */}
      <p className="paper-label font-sans">{page.sectionPath}</p>

      <h1 className="mt-4 text-[22px] leading-[1.3] font-semibold text-paper-text">
        {page.heading}
      </h1>

      <div className="mt-5 flex flex-col gap-4">
        {page.blocks.map((block, index) =>
          block.kind === "heading" ? (
            <h2
              key={index}
              className="mt-3 text-[18px] leading-[1.4] font-semibold text-paper-text"
            >
              {block.text}
            </h2>
          ) : (
            <p key={index} className="text-paper-text">
              {block.text}
            </p>
          ),
        )}
      </div>

      {/* Page numbers are mono, like every other number in the application. */}
      <p className="num mt-10 border-t border-paper-edge pt-4 text-mono-xs text-paper-text-muted">
        Page {page.pageNumber}
      </p>
    </>
  );
}
