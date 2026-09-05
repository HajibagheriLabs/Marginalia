"use client";

import { useEffect, useMemo, useRef } from "react";

import { pageAnchorProps, textAnchorProps } from "@/lib/viewer/anchors";
import { segmentBlock, splitBlocks } from "@/lib/viewer/blocks";
import type { DocumentMatch } from "@/lib/viewer/search";
import type { ViewerPage } from "@/lib/viewer/types";

/**
 * ONE PAGE OF A NON-PDF DOCUMENT.
 *
 * DOCX, TXT, and Markdown have no pages, so the extractor invented boundaries
 * for them at roughly a printed page of prose each and recorded the same
 * `char_start`/`char_end` it records for a real PDF page. This renders those
 * blocks as document text on the same paper sheet, in the same serif, at the
 * same measure.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE DOM TEXT IS THE STORED TEXT
 *
 * Nothing here reflows, trims, or prettifies. Paragraphs are a partition of the
 * page on blank lines, and `white-space: pre-wrap` keeps every remaining line
 * break as the character it is. That is not fussiness about fidelity — it is
 * what makes citation targeting arithmetic instead of guesswork. A chunk's
 * `char_start` resolves to a DOM position by counting characters, with no
 * fuzzy matching anywhere in the path, because the characters on screen ARE
 * the characters the chunker measured.
 *
 * It is the one place the viewer is strictly better than the PDF path, where
 * the same offset has to be matched against PDF.js's own text. Same contract,
 * same attributes, better guarantee — see `anchors.ts`.
 */
export function TextPage({
  page,
  index,
  /** Matches on THIS page, page-relative, with their document-wide index. */
  matches,
  currentMatchIndex,
  onMeasure,
}: {
  page: ViewerPage;
  index: number;
  matches: { match: DocumentMatch; index: number }[];
  currentMatchIndex: number | null;
  onMeasure: (index: number, height: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const blocks = useMemo(() => splitBlocks(page.text ?? ""), [page.text]);

  /**
   * Report the rendered height so the virtualiser can replace its estimate.
   *
   * A ResizeObserver rather than a one-shot measurement: the pane is
   * resizable, and a page's height changes with every drag of the conversation
   * pane's edge. Without this, the placeholders below a resized page would all
   * be wrong and the scrollbar would lie.
   */
  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const report = () => onMeasure(index, element.getBoundingClientRect().height);
    report();

    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [index, onMeasure, blocks]);

  return (
    <div ref={ref} {...pageAnchorProps(page)} className="flex flex-col">
      <div className="flex flex-col gap-4">
        {blocks.map((block) => {
          const segments = segmentBlock(
            block,
            matches.map(({ match, index: matchIndex }) => ({
              match,
              index: matchIndex,
            })),
          );

          return (
            <p
              key={block.charStart}
              {...textAnchorProps(page.charStart + block.charStart)}
              // pre-wrap, not normal: a Markdown file's hard wraps and an
              // indented block's leading spaces are characters in the stored
              // text. Collapsing them for display would put the DOM and the
              // offsets one space apart per line, and the drift is invisible
              // until a citation lands on the wrong sentence.
              className="whitespace-pre-wrap text-paper-text"
            >
              {segments.map((segment) =>
                segment.matchIndex === null ? (
                  <span
                    key={segment.charStart}
                    {...textAnchorProps(page.charStart + segment.charStart)}
                  >
                    {segment.text}
                  </span>
                ) : (
                  <mark
                    key={segment.charStart}
                    {...textAnchorProps(page.charStart + segment.charStart)}
                    data-match-index={segment.matchIndex}
                    data-current={segment.matchIndex === currentMatchIndex}
                    className="search-mark"
                  >
                    {segment.text}
                  </mark>
                ),
              )}
            </p>
          );
        })}
      </div>
    </div>
  );
}
