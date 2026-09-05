"use client";

import { useState, type CSSProperties } from "react";
import { FileText, Inbox } from "lucide-react";

import {
  CitationChip,
  CitationChipWithPreview,
} from "@/components/citation-chip";
import { Composer } from "@/components/composer";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { AnswerMarkdown } from "@/components/conversation/answer-markdown";
import { AnswerMeta } from "@/components/conversation/answer-meta";
import { RetrievalTrace } from "@/components/conversation/retrieval-trace";
import { DocumentListItem } from "@/components/document-list-item";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { MessageBubble } from "@/components/message-bubble";
import { PaperSheet } from "@/components/paper-sheet";
import {
  DocumentListSkeleton,
  MessageSkeleton,
  Skeleton,
  SkeletonText,
} from "@/components/skeleton";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PlaceholderPageContent } from "@/components/workspace/placeholder-page";
import type { UITraceRow } from "@/lib/chat/types";
import { ALL_DOCUMENT_STATUSES } from "@/lib/document-status";
import { INKS, inkVar } from "@/lib/ink";
import { PLACEHOLDER_PAGE } from "@/lib/placeholder";

/**
 * SCAFFOLDING — a working inventory of the component layer.
 *
 * Every reusable component in every state it has, on one page, so a change to
 * one of them can be judged against all the others instead of one screen at a
 * time. It sits behind the authenticated shell rather than being published, and
 * it goes away once the components stop changing.
 */

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 border-t border-edge pt-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-section-title text-text">{title}</h2>
        {note ? <p className="text-body-sm text-text-muted">{note}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** One answer, exercising every block the parser supports. */
const SAMPLE_ANSWER = `Either party may terminate for convenience on **sixty (60) days** written notice [1]. Two things follow from that:

- Fees accrued to the effective date stay payable within thirty days [1].
- Work in progress is invoiced at the \`T&M\` rate in the rate card [2].

| Trigger | Notice | Cure |
| :--- | ---: | :---: |
| Convenience | 60 days | — |
| Material breach | 30 days | 15 days [3] |

Nothing in these documents sets a cure period for late delivery. Try the statement of work — delivery terms usually sit there rather than in the master agreement.`;

/** A trace with a dense-only hit, a lexical-only hit, and a rejected candidate. */
const SAMPLE_TRACE: UITraceRow[] = [
  {
    chunkId: "a",
    documentId: "d1",
    documentTitle: "Master Services Agreement",
    snippet:
      "Either party may terminate this Agreement for convenience upon sixty (60) days prior written notice to the other party.",
    pageFrom: 14,
    pageTo: 14,
    denseRank: 1,
    denseScore: 0.712,
    lexicalRank: 2,
    lexicalScore: 0.184,
    rrfScore: 0.0323,
    rerankScore: null,
    used: true,
  },
  {
    chunkId: "b",
    documentId: "d1",
    documentTitle: "Master Services Agreement",
    snippet:
      "Fees accrued through the effective date of termination remain payable within thirty (30) days of the final invoice.",
    pageFrom: 14,
    pageTo: 15,
    denseRank: 4,
    denseScore: 0.618,
    lexicalRank: null,
    lexicalScore: null,
    rrfScore: 0.0156,
    rerankScore: null,
    used: true,
  },
  {
    chunkId: "c",
    documentId: "d2",
    documentTitle: "Statement of Work 04",
    snippet:
      "Material breach may be cured within fifteen (15) days of written notice describing the breach in reasonable detail.",
    pageFrom: 2,
    pageTo: 2,
    denseRank: null,
    denseScore: null,
    lexicalRank: 1,
    lexicalScore: 0.241,
    rrfScore: 0.0164,
    rerankScore: null,
    used: true,
  },
  {
    chunkId: "d",
    documentId: "d1",
    documentTitle: "Master Services Agreement",
    snippet:
      "Notices under this Agreement are effective on receipt and must be sent to the addresses set out in Schedule 1.",
    pageFrom: 31,
    pageTo: 31,
    denseRank: 9,
    denseScore: 0.501,
    lexicalRank: 18,
    lexicalScore: 0.031,
    rrfScore: 0.0272,
    rerankScore: null,
    used: false,
  },
];

export function ComponentGallery() {
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="mx-auto flex w-full max-w-[840px] flex-col gap-8 px-5 py-10">
        <header className="flex flex-col gap-1">
          <p className="label">Light Table</p>
          <h1 className="text-page-title text-text">Component inventory</h1>
          <p className="text-body text-text-muted">
            Every reusable piece, in every state. Switch the room between dark
            and light from the account menu — the paper sheet at the bottom does
            not change.
          </p>
        </header>

        <Section
          title="StatusDot"
          note="The ingestion state machine. System-state colours, never inks."
        >
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {ALL_DOCUMENT_STATUSES.map((status) => (
              <StatusDot key={status} status={status} showLabel />
            ))}
          </div>
        </Section>

        <Section
          title="DocumentListItem"
          note="The expanded rail, then the 56px icon rail. Titles move into tooltips when collapsed."
        >
          <div className="flex gap-6">
            <div className="flex w-[240px] flex-col gap-0.5 rounded-panel border border-edge bg-surface p-2">
              <DocumentListItem
                href="#"
                title="Master Services Agreement — Northwind Systems"
                pageCount={24}
                status="ready"
                active
              />
              <DocumentListItem
                href="#"
                title="Employee handbook 2026"
                pageCount={58}
                status="embedding"
              />
              <DocumentListItem
                href="#"
                title="Warehouse lease (scanned)"
                pageCount={31}
                status="failed"
              />
              <DocumentListItem
                href="#"
                title="Termination addendum"
                pageCount={null}
                status="uploaded"
              />
            </div>

            <div className="flex w-14 flex-col items-center gap-1 rounded-panel border border-edge bg-surface p-2">
              <DocumentListItem
                href="#"
                title="Master Services Agreement"
                pageCount={24}
                status="ready"
                active
                collapsed
              />
              <DocumentListItem
                href="#"
                title="Employee handbook 2026"
                pageCount={58}
                status="embedding"
                collapsed
              />
              <DocumentListItem
                href="#"
                title="Warehouse lease (scanned)"
                pageCount={31}
                status="failed"
                collapsed
              />
            </div>
          </div>
        </Section>

        <Section
          title="CitationChip"
          note="The four highlighter inks, one per source document, cycling in order. The last chip is the passage currently lit on the page."
        >
          <div className="flex flex-wrap items-center gap-2">
            {INKS.map((ink, index) => (
              <CitationChip
                key={ink}
                marker={index + 1}
                ink={ink}
                documentTitle="Master Services Agreement"
                page={14}
              />
            ))}
            <CitationChip marker={5} ink="citrine" active />
          </div>
          <p className="text-body-sm text-text-muted">
            Hover or focus the chip below. The preview is a popover, so it
            carries the overlay shadow — but the quote inside it is paper.
          </p>
          <div>
            <CitationChipWithPreview
              marker={1}
              ink="citrine"
              documentTitle="Master Services Agreement"
              pageFrom={14}
              pageTo={14}
              quotedText="Either party may terminate this Agreement for convenience upon sixty (60) days prior written notice to the other party. Fees accrued through the effective date of termination remain payable within thirty (30) days."
            />
          </div>
        </Section>

        <Section
          title="MessageBubble"
          note="A user message is a landmark and gets a container. An assistant answer is the content and gets none."
        >
          <div className="flex flex-col gap-5 rounded-panel border border-edge p-4">
            <MessageBubble role="user">
              What notice do we have to give to terminate for convenience?
            </MessageBubble>
            <MessageBubble role="assistant">
              Either party may terminate for convenience on sixty (60) days
              written notice{" "}
              <CitationChip marker={1} ink="citrine" page={14} />. Terminating
              during an initial period still leaves the fees for the rest of
              that period payable within thirty days{" "}
              <CitationChip marker={2} ink="citrine" page={14} />.
            </MessageBubble>
            <MessageBubble role="assistant">
              Nothing in these documents mentions a cure period for late
              delivery. Try uploading the statement of work — delivery terms
              usually sit there rather than in the master agreement.
            </MessageBubble>
          </div>
        </Section>

        <Section
          title="AnswerMarkdown"
          note="Markdown for lists, bold, and tables — monochrome throughout. The only coloured thing an answer can contain is a citation chip."
        >
          <div className="rounded-panel border border-edge p-4">
            <AnswerMarkdown
              text={SAMPLE_ANSWER}
              renderMarker={(marker) => (
                <CitationChipWithPreview
                  marker={marker}
                  ink={marker === 3 ? "rose" : "citrine"}
                  documentTitle={
                    marker === 3
                      ? "Statement of Work 04"
                      : "Master Services Agreement"
                  }
                  pageFrom={marker === 3 ? 2 : 14}
                  pageTo={marker === 3 ? 2 : 14}
                  quotedText="Either party may terminate this Agreement for convenience upon sixty (60) days prior written notice to the other party."
                />
              )}
            />
          </div>
        </Section>

        <Section
          title="RetrievalTrace"
          note="Collapsed by default. The rows that lost are the interesting ones, and an em dash means that channel never returned the passage at all."
        >
          <div className="rounded-panel border border-edge p-4">
            <RetrievalTrace rows={SAMPLE_TRACE} />
          </div>
        </Section>

        <Section
          title="AnswerMeta"
          note="The quiet footer. Zero is the real cost on the free pool rather than an estimate, so it reads 'free' instead of $0.00."
        >
          <div className="flex flex-col gap-3 rounded-panel border border-edge p-4">
            <AnswerMeta
              metadata={{
                model: "meta-llama/llama-3.3-70b-instruct:free",
                promptTokens: 2841,
                completionTokens: 176,
                costCents: 0,
                latencyMs: 3120,
                finishReason: "stop",
                invalidMarkers: [],
              }}
            />
            <AnswerMeta
              metadata={{
                model: null,
                promptTokens: null,
                completionTokens: null,
                costCents: 0,
                latencyMs: 412,
                finishReason: "no-context",
                invalidMarkers: [],
              }}
            />
            <AnswerMeta
              metadata={{
                model: "qwen/qwen-2.5-72b-instruct:free",
                promptTokens: 3102,
                completionTokens: 204,
                costCents: 0,
                latencyMs: 5980,
                finishReason: "stop",
                invalidMarkers: [9],
              }}
            />
          </div>
        </Section>

        <Section
          title="Composer"
          note="Grows to eight lines, then scrolls. Cmd/Ctrl+Enter sends; a bare Enter is a newline. While an answer streams, send becomes stop and the box stays live."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Composer onSubmit={() => {}} />
            <Composer
              onSubmit={() => {}}
              disabled
              disabledReason="Select at least one document."
            />
            <Composer onSubmit={() => {}} streaming onStop={() => {}} />
            <Composer
              onSubmit={() => {}}
              disabled
              disabledReason="Contract.pdf is still embedding."
            />
          </div>
        </Section>

        <Section title="EmptyState and ErrorState">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-panel border border-edge">
              <EmptyState
                icon={Inbox}
                title="No documents yet. Upload one to start asking questions."
                action={
                  <Button variant="outline" size="sm">
                    Upload a document
                  </Button>
                }
              />
            </div>
            <ErrorState
              title="This document could not be processed."
              detail="Extraction found no text on any page. Upload a searchable PDF, or run OCR on it first."
              action={
                <Button variant="outline" size="sm">
                  Retry
                </Button>
              }
            />
          </div>
        </Section>

        <Section
          title="Skeletons"
          note="Nothing shimmers. The motion budget belongs to streaming text and citations."
        >
          <div className="grid gap-6 sm:grid-cols-3">
            <DocumentListSkeleton rows={3} />
            <MessageSkeleton />
            <div className="flex flex-col gap-3">
              <Skeleton className="h-8 w-full" />
              <SkeletonText lines={2} />
            </div>
          </div>
        </Section>

        <Section
          title="ConfirmDialog"
          note="The confirm button names the action it performs."
        >
          <div>
            <Button variant="outline" onClick={() => setConfirmOpen(true)}>
              Delete document
            </Button>
            <ConfirmDialog
              open={confirmOpen}
              onOpenChange={setConfirmOpen}
              destructive
              title="Delete this document?"
              description="Its passages, embeddings, and the citations pointing at it are removed. Answers that cited it keep their text but lose their sources."
              confirmLabel="Delete document"
              onConfirm={() => {}}
            />
          </div>
        </Section>

        <Section
          title="Buttons"
          note="Monochrome. The destructive variant is a system state, not an ink."
        >
          <div className="flex flex-wrap items-center gap-2">
            <Button>Primary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">Delete</Button>
            <Button variant="link">Link</Button>
            <Button disabled>Disabled</Button>
            <Button size="icon" aria-label="A document">
              <FileText aria-hidden />
            </Button>
          </div>
        </Section>

        <Section
          title="PaperSheet"
          note="The only lifted surface in the application, and the only colour that belongs on it."
        >
          <PaperSheet className="max-w-none">
            <p className="paper-label font-sans">
              Master Services Agreement › 7. Term and termination
            </p>
            <p className="mt-4 text-paper-text">
              Either party may terminate this Agreement for convenience upon{" "}
              <mark
                className="ink-highlight text-paper-text"
                style={{ "--ink": inkVar("citrine") } as CSSProperties}
              >
                sixty (60) days prior written notice
              </mark>{" "}
              to the other party. Termination does not relieve either party of
              obligations accrued before the effective date.
            </p>
            <p className="num mt-6 text-mono-xs text-paper-text-muted">
              Page 14
            </p>
          </PaperSheet>
        </Section>

        <Section
          title="Reading experience"
          note="A full page at the real measure: 17px Source Serif 4, 1.65 leading, margins setting a ~65 character column. Nothing extracts document text yet, so this is a stand-in."
        >
          {/* The sheet at its real 720px width, so the column really is the
              measure the design specifies rather than the gallery's. */}
          <PaperSheet>
            <PlaceholderPageContent page={PLACEHOLDER_PAGE} />
          </PaperSheet>
        </Section>
      </div>
    </TooltipProvider>
  );
}
