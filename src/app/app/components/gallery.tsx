"use client";

import { useState, type CSSProperties } from "react";
import { FileText, Inbox } from "lucide-react";

import { CitationChip } from "@/components/citation-chip";
import { Composer } from "@/components/composer";
import { ConfirmDialog } from "@/components/confirm-dialog";
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
import { ALL_DOCUMENT_STATUSES } from "@/lib/document-status";
import { INKS, inkVar } from "@/lib/ink";

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
          title="Composer"
          note="Grows to eight lines, then scrolls. Cmd/Ctrl+Enter sends; a bare Enter is a newline."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Composer onSubmit={() => {}} />
            <Composer
              onSubmit={() => {}}
              disabled
              disabledReason="This document is not ready to search yet."
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
      </div>
    </TooltipProvider>
  );
}
