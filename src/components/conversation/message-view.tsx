"use client";

import { useMemo } from "react";

import { CitationChipWithPreview } from "@/components/citation-chip";
import {
  markId,
  useBridgeState,
  useCitationBridge,
} from "@/components/viewer/citation-bridge";
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

/**
 * THE ANSWER, ANNOUNCED ONCE, WHEN IT IS FINISHED.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THE LIVE REGION IS NOT ON THE ANSWER ITSELF
 *
 * The obvious implementation puts `aria-live="polite"` on the streaming text
 * and is unusable. A polite region announces its content EVERY TIME IT
 * CHANGES, and this content changes once per token — so a screen reader
 * queues a hundred overlapping announcements, each one the whole answer so
 * far, and the reader hears the first sentence a hundred times before the
 * paragraph finishes. It is worse than no announcement at all, because it also
 * blocks everything else the user might want to hear.
 *
 * So the live region is a SEPARATE, EMPTY, visually hidden node that stays
 * empty for the whole stream and receives the finished text exactly once, when
 * `streaming` goes false. One announcement, of the complete answer, at the
 * moment there is something worth reading.
 *
 * The region is present in the DOM from the start rather than mounted at the
 * end, because a live region that appears already populated is not announced —
 * the technology watches for CHANGES inside an existing region.
 *
 * Sighted readers lose nothing: they can already see the text arriving, which
 * is what the streaming animation is for.
 */
function AnswerAnnouncement({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  /*
   * DERIVED DURING RENDER, not synchronised in an effect.
   *
   * Empty for the whole stream, the finished text afterwards — which is one
   * content change inside an existing live region, which is exactly one
   * announcement. Going back to empty when the next answer starts streaming
   * announces nothing (a region emptying is not news) and leaves the region
   * ready to change again, so a second question is announced like the first.
   *
   * MARKERS ARE SPOKEN, NOT READ OUT AS PUNCTUATION. The stored text carries
   * `[1]`, which a screen reader renders as "left bracket one right bracket" —
   * noise in the middle of every sentence, and it does not say what the bracket
   * MEANS. "(citation 1)" is the same fact in words, and the chip itself is
   * still in the tab order announcing its document and page.
   */
  const spoken = streaming
    ? ""
    : text.replace(/\[(\d{1,3})\]/g, (_match, marker) => `(citation ${marker})`);

  return (
    <p role="status" aria-live="polite" className="sr-only">
      {spoken}
    </p>
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
  // The chip is the trigger for the whole click-to-source interaction, and the
  // pane it drives is on the other side of the workbench — below 1024px, in
  // the other tab. The bridge is what reaches it. See citation-bridge.tsx.
  const bridge = useCitationBridge();
  const { active } = useBridgeState();

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
    <div
      data-role="assistant"
      // `aria-busy` while the tokens are arriving, so assistive technology knows
      // the subtree is mid-update and does not read a half-written sentence as
      // if it were finished.
      aria-busy={streaming || undefined}
      className="flex flex-col gap-3"
    >
      <AnswerAnnouncement text={body} streaming={streaming} />

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

          const id = markId(message.id, marker);

          return (
            <CitationChipWithPreview
              marker={marker}
              ink={inkFor(citation.documentId)}
              documentTitle={citation.documentTitle}
              pageFrom={citation.pageFrom}
              pageTo={citation.pageTo}
              quotedText={citation.quotedText}
              // Clicking the same chip twice re-activates it rather than doing
              // nothing: the nonce changes, so the page scrolls back and the
              // wipe replays. A citation you have lost track of is exactly the
              // one you click again.
              onClick={() => bridge.activate(id)}
              active={active?.markId === id}
            />
          );
        }}
      />

      {/*
        AN ANSWER WITH NO CITATIONS SAYS SO.

        It happens for two quite different reasons and the reader cannot tell
        them apart from the text alone: retrieval found nothing above the floor
        (in which case the answer is the "nothing in these documents covers
        that" sentence and no model was called), or a model was given passages
        and wrote a paragraph without attaching a marker to anything.

        The second is the one worth naming. It looks exactly like a normal
        answer — fluent, plausible, and resting on nothing the reader can check
        — and silence about it is the interface implying a grounding it does
        not have. The trace below is the action: it shows what WAS retrieved,
        which is the only way to find out whether the passages were there and
        went uncited.

        Suppressed when there were no candidates at all, because then the
        answer's own first sentence already says it.
      */}
      {!streaming &&
      citationPart &&
      citationPart.citations.length === 0 &&
      (tracePart?.rows.length ?? 0) > 0 ? (
        <p className="measure text-body-sm text-text-faint">
          This answer cites no passages. Open the retrieval below to see what
          was found.
        </p>
      ) : null}

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
