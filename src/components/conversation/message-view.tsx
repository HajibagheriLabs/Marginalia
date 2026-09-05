"use client";

import { useMemo } from "react";

import { CitationChipWithPreview } from "@/components/citation-chip";
import { AnswerMarkdown } from "@/components/conversation/answer-markdown";
import { AnswerMeta } from "@/components/conversation/answer-meta";
import { RetrievalTrace } from "@/components/conversation/retrieval-trace";
import { MessageSkeleton } from "@/components/skeleton";
import {
  messageCitations,
  messageText,
  messageTrace,
  type MarginaliaUIMessage,
  type UICitation,
} from "@/lib/chat/types";
import { stripInvalidMarkers } from "@/lib/chat/markdown";
import type { InkName } from "@/lib/ink";
import { cn } from "@/lib/utils";

/**
 * ONE TURN IN THE CONVERSATION.
 *
 * The three roles are not variations on a theme; they are three different
 * kinds of thing and they are drawn as such.
 *
 *   USER — a short thing you wrote. It gets a --surface container so you can
 *   find it while scrolling back. It is a landmark, not content.
 *
 *   ASSISTANT — a grounded answer with citations in it, and the thing you are
 *   actually here to read. NO container: plain text on --room at a 68ch
 *   measure. A bubble would narrow it, box it, and make a written response with
 *   sources look like chat.
 *
 *   SYSTEM — a scope change. A hairline with a sentence on it, because it is
 *   not a turn at all; it is a note about how to read the turns below it.
 */
export function MessageView({
  message,
  inkFor,
  streaming = false,
}: {
  message: MarginaliaUIMessage;
  /** documentId -> ink, from the conversation's scope order. */
  inkFor: (documentId: string) => InkName;
  /** True for the last assistant message while tokens are still arriving. */
  streaming?: boolean;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div
          data-role="user"
          className="max-w-[85%] rounded-panel bg-surface px-3 py-2 text-body whitespace-pre-wrap text-text"
        >
          {messageText(message)}
        </div>
      </div>
    );
  }

  if (message.role === "system") {
    return (
      <div
        role="note"
        className="flex items-center gap-3 py-1 text-mono-xs text-text-faint"
      >
        <span aria-hidden className="h-px flex-1 bg-edge" />
        <span className="text-center font-sans text-body-sm">
          {messageText(message)}
        </span>
        <span aria-hidden className="h-px flex-1 bg-edge" />
      </div>
    );
  }

  return (
    <AssistantMessage
      message={message}
      inkFor={inkFor}
      streaming={streaming}
    />
  );
}

function AssistantMessage({
  message,
  inkFor,
  streaming,
}: {
  message: MarginaliaUIMessage;
  inkFor: (documentId: string) => InkName;
  streaming: boolean;
}) {
  const text = messageText(message);
  const citationPart = messageCitations(message);
  const tracePart = messageTrace(message);
  const metadata = message.metadata;

  const byMarker = useMemo(() => {
    const map = new Map<number, UICitation>();
    for (const citation of citationPart?.citations ?? []) {
      map.set(citation.marker, citation);
    }
    return map;
  }, [citationPart]);

  // Markers the model invented were stripped from the STORED answer, but the
  // deltas carrying them were already on screen. Removing them here is what
  // makes the live view and a reload show the same answer.
  const body = stripInvalidMarkers(text, metadata?.invalidMarkers ?? []);

  // Retrieval and the first token happen in that order, and retrieval is the
  // slow half: embedding the query, two channel searches, fusion. The skeleton
  // covers exactly that gap and is replaced the instant text exists.
  if (streaming && body.length === 0) return <MessageSkeleton />;

  return (
    <div data-role="assistant" className="flex flex-col gap-3">
      <AnswerMarkdown
        className="measure"
        text={body}
        renderMarker={(marker) => {
          const citation = byMarker.get(marker);

          // Mid-stream a marker can legitimately arrive before its citations
          // part does. It renders as the plain number it is until then, rather
          // than as a chip in a colour that might turn out to be wrong.
          if (!citation) {
            return <span className="num text-text-muted">[{marker}]</span>;
          }

          return (
            <CitationChipWithPreview
              marker={marker}
              ink={inkFor(citation.documentId)}
              documentTitle={citation.documentTitle}
              pageFrom={citation.pageFrom}
              pageTo={citation.pageTo}
              quotedText={citation.quotedText}
            />
          );
        }}
      />

      {/* Both appear only once the answer has finished. A trace table sliding
          in under text that is still moving would be the second animation in a
          system that allows one. */}
      {!streaming && tracePart ? (
        <div className={cn("flex flex-col gap-2", "measure")}>
          <RetrievalTrace rows={tracePart.rows} />
          {metadata ? <AnswerMeta metadata={metadata} /> : null}
        </div>
      ) : null}
    </div>
  );
}
