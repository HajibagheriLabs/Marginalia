"use client";

import { Fragment, useMemo, type ReactNode } from "react";

import {
  parseMarkdown,
  type Block,
  type Inline,
  type TableAlign,
} from "@/lib/chat/markdown";
import { cn } from "@/lib/utils";

/**
 * AN ANSWER, RENDERED.
 *
 * The token tree from `parseMarkdown` becomes React elements here, and every
 * element gets its class from this file — which is the point of parsing to
 * tokens rather than to HTML. Two rules follow from the design system and are
 * enforced by construction:
 *
 *   NO COLOUR. Not in code blocks, not in links, not in table headers. The only
 *   coloured thing that can appear inside an answer is a citation chip, and it
 *   arrives through `renderMarker` — this file never picks a colour at all.
 *   Links carry their affordance in an underline, exactly as the button
 *   variants do.
 *
 *   NO CONTAINER. The answer is plain text on --room at a comfortable measure.
 *   It is the thing the reader came for, and boxing it would make it look like
 *   chat rather than a written response with sources.
 */

export function AnswerMarkdown({
  text,
  renderMarker,
  className,
}: {
  text: string;
  /**
   * Turns `[3]` into a chip. Passed in rather than imported so this component
   * knows nothing about inks, documents, or which citation resolved — the ink
   * belongs to a source document and only the message knows the mapping.
   */
  renderMarker: (marker: number) => ReactNode;
  className?: string;
}) {
  // Parsed once per answer rather than once per render. Activating a citation
  // re-renders every message in the thread so the clicked chip can light up,
  // and re-parsing forty answers to move one highlight would be the wrong kind
  // of expensive.
  const blocks = useMemo(() => parseMarkdown(text), [text]);

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} renderMarker={renderMarker} />
      ))}
    </div>
  );
}

const ALIGN: Record<TableAlign, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

/** Headings inside an answer step down from the pane's own section titles. */
const HEADING_CLASS: Record<number, string> = {
  1: "text-section-title text-text",
  2: "text-section-title text-text",
  3: "text-body font-semibold text-text",
  4: "text-body font-semibold text-text",
  5: "text-body-sm font-semibold text-text",
  6: "text-body-sm font-semibold text-text",
};

function BlockView({
  block,
  renderMarker,
}: {
  block: Block;
  renderMarker: (marker: number) => ReactNode;
}) {
  switch (block.kind) {
    case "paragraph":
      return (
        <p className="text-body text-text">
          <InlineView nodes={block.inline} renderMarker={renderMarker} />
        </p>
      );

    case "heading": {
      const Tag = `h${block.level}` as "h1";
      return (
        <Tag className={cn("mt-1", HEADING_CLASS[block.level])}>
          <InlineView nodes={block.inline} renderMarker={renderMarker} />
        </Tag>
      );
    }

    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag
          start={block.ordered ? block.start : undefined}
          className={cn(
            "flex flex-col gap-1.5 pl-5 text-body text-text marker:text-text-faint",
            block.ordered ? "list-decimal" : "list-disc",
          )}
        >
          {block.items.map((item, index) => (
            <li
              key={index}
              // Every number in this application is set in the mono face, and a
              // list marker is a number. `::marker` inherits from the ITEM, not
              // from the list, so the variant has to live here.
              className={
                block.ordered ? "marker:font-mono marker:tabular-nums" : undefined
              }
            >
              <InlineView nodes={item.inline} renderMarker={renderMarker} />
              {item.children.length > 0 ? (
                <div className="mt-1.5 flex flex-col gap-1.5">
                  {item.children.map((child, childIndex) => (
                    <BlockView
                      key={childIndex}
                      block={child}
                      renderMarker={renderMarker}
                    />
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </Tag>
      );
    }

    case "quote":
      return (
        <blockquote className="flex flex-col gap-2 border-l-2 border-edge-strong pl-3 text-text-muted">
          {block.blocks.map((child, index) => (
            <BlockView key={index} block={child} renderMarker={renderMarker} />
          ))}
        </blockquote>
      );

    case "code":
      // Monochrome, deliberately. A highlighting theme is a palette, and a
      // palette inside an answer would compete with the one thing colour means
      // here. The language is not even rendered — it would be a label on a
      // block that looks identical either way.
      return (
        <pre className="overflow-x-auto rounded-panel border border-edge bg-surface p-3">
          <code className="text-mono-sm text-text-muted">{block.value}</code>
        </pre>
      );

    case "table":
      return (
        // The pane is 400–520px and a table is the one block that will not fold
        // into it. It scrolls inside its own box rather than widening the
        // measure of everything around it.
        <div className="overflow-x-auto rounded-panel border border-edge">
          <table className="w-full border-collapse text-body-sm">
            <thead>
              <tr className="border-b border-edge">
                {block.head.map((cell, index) => (
                  <th
                    key={index}
                    className={cn(
                      "px-2.5 py-1.5 font-medium text-text-muted",
                      ALIGN[block.align[index] ?? "left"],
                    )}
                  >
                    <InlineView nodes={cell} renderMarker={renderMarker} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr
                  key={rowIndex}
                  className="border-b border-edge last:border-b-0"
                >
                  {row.map((cell, cellIndex) => (
                    <td
                      key={cellIndex}
                      className={cn(
                        "px-2.5 py-1.5 align-top text-text",
                        ALIGN[block.align[cellIndex] ?? "left"],
                      )}
                    >
                      <InlineView nodes={cell} renderMarker={renderMarker} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case "rule":
      return <hr className="border-t border-edge" />;
  }
}

function InlineView({
  nodes,
  renderMarker,
}: {
  nodes: Inline[];
  renderMarker: (marker: number) => ReactNode;
}) {
  return (
    <>
      {nodes.map((node, index) => (
        <Fragment key={index}>
          {node.kind === "text" ? (
            node.value
          ) : node.kind === "strong" ? (
            <strong className="font-semibold">
              <InlineView nodes={node.children} renderMarker={renderMarker} />
            </strong>
          ) : node.kind === "em" ? (
            <em className="italic">
              <InlineView nodes={node.children} renderMarker={renderMarker} />
            </em>
          ) : node.kind === "code" ? (
            <code className="rounded-control bg-surface px-1 py-0.5 text-mono-sm text-text-muted">
              {node.value}
            </code>
          ) : node.kind === "link" ? (
            <a
              href={node.href}
              target="_blank"
              // An answer's links point outside this application. `noopener`
              // denies the opened page a handle on this window; `noreferrer`
              // keeps the conversation's URL out of its logs.
              rel="noopener noreferrer"
              className="underline underline-offset-4 hover:text-text-muted"
            >
              <InlineView nodes={node.children} renderMarker={renderMarker} />
            </a>
          ) : (
            renderMarker(node.marker)
          )}
        </Fragment>
      ))}
    </>
  );
}
