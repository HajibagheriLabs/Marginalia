import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { z } from "zod";

import { requireConversationAccess } from "@/lib/auth-server";
import { titleFromQuestion } from "@/lib/chat/title";
import { toUITraceRow } from "@/lib/chat/trace";
import type { MarginaliaUIMessage } from "@/lib/chat/types";
import {
  persistUserMessage,
  setConversationTitleIfUnset,
  touchConversation,
} from "@/lib/conversations";
import { answer } from "@/lib/llm";

/**
 * THE CONVERSATION ENDPOINT.
 *
 *   question → retrieve → generate → validate → persist
 *
 * A thin adapter and nothing else. Every decision that matters — what to
 * retrieve, which model to try, whether a marker is real, what to store — lives
 * in `answer()`. This file translates its `AnswerEvent`s into the AI SDK's UI
 * message chunks and gets out of the way. The moment it starts making
 * retrieval or generation decisions, they are in the wrong place.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE CLIENT SENDS A QUESTION. IT DOES NOT SEND THE CONVERSATION.
 *
 * The AI SDK's default transport posts the entire message array on every turn,
 * and the obvious server would take that array as the thread. This one does
 * not: the body carries a conversation id and one question, and every other
 * fact — which documents are in scope, what was asked before, what was answered
 * — is read from the database under the session's user id. The client-side
 * `prepareSendMessagesRequest` trims the request to match.
 *
 * That is a security boundary, not a bandwidth optimisation. A client that can
 * send history can send history that never happened, and the document scope is
 * what keeps one user's vector search out of another user's documents. Scope
 * changes go through `setConversationScope`, which re-checks ownership and
 * writes a note into the thread; there is deliberately no way to change scope
 * by sending a different array here.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THE NODE RUNTIME
 *
 * Query embedding runs locally, in-process, through Transformers.js. It needs
 * the model weights resident in a warm Node process and cannot run on Edge —
 * the same constraint that governs the ingestion worker.
 */

export const runtime = "nodejs";

/**
 * Retrieval, generation, and validation inside one invocation. Vercel reads
 * this export at build time, so it must be a literal.
 */
export const maxDuration = 300;

const requestSchema = z.object({
  conversationId: z.uuid(),
  question: z.string().trim().min(1).max(4000),
  /**
   * `submit-message` for a new question, `regenerate-message` for a retry after
   * an error. A retry must not persist the question twice — that row is already
   * there; it is the answer that never was.
   */
  trigger: z
    .enum(["submit-message", "regenerate-message"])
    .default("submit-message"),
});

export async function POST(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Malformed body" }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json({ error: "Malformed body" }, { status: 400 });
  }

  const { conversationId, question, trigger } = parsed.data;

  // The ownership boundary. 404s identically whether the conversation is
  // missing or belongs to somebody else.
  const { user, conversation } = await requireConversationAccess(conversationId);

  if (trigger === "submit-message") {
    await persistUserMessage({
      conversationId: conversation.id,
      content: question,
    });
    // Titled once, from the first question, by a predicate inside the UPDATE —
    // see `setConversationTitleIfUnset` for why this cannot race into two
    // different titles.
    await setConversationTitleIfUnset(
      conversation.id,
      titleFromQuestion(question),
    );
  }

  await touchConversation(conversation.id);

  const stream = createUIMessageStream<MarginaliaUIMessage>({
    execute: async ({ writer }) => {
      // One text part per answer. This id ties `text-start`, every delta, and
      // `text-end` to the same part on the client.
      const textId = `answer-${conversation.id}-${Date.now()}`;
      let textOpen = false;

      const closeText = () => {
        if (!textOpen) return;
        writer.write({ type: "text-end", id: textId });
        textOpen = false;
      };

      for await (const event of answer({
        userId: user.id,
        conversationId: conversation.id,
        // FROM THE DATABASE, never from the request body.
        documentIds: conversation.documentIds,
        question,
        // Closing the tab or pressing stop aborts generation rather than paying
        // for an answer nobody will read. `answer()` returns without persisting.
        signal: request.signal,
      })) {
        switch (event.type) {
          case "start":
            writer.write({ type: "text-start", id: textId });
            textOpen = true;
            break;

          case "text":
            writer.write({ type: "text-delta", id: textId, delta: event.delta });
            break;

          case "citations":
            closeText();
            writer.write({
              type: "data-citations",
              data: { citations: event.citations },
            });
            break;

          case "trace":
            writer.write({
              type: "data-trace",
              data: { rows: event.candidates.map(toUITraceRow) },
            });
            break;

          case "done":
            writer.write({
              type: "message-metadata",
              messageMetadata: event.message,
            });
            break;

          case "error":
            // A WRITTEN error chunk passes through untouched, unlike a thrown
            // one — `onError` below exists to mask those. Every message the
            // engine produces here is written for a reader: it names what
            // happened and what to do about it, so masking it would replace the
            // one useful sentence with a generic one.
            closeText();
            writer.write({ type: "error", errorText: event.message });
            break;
        }
      }

      closeText();
    },

    /**
     * Anything reaching here is an unhandled exception, and its message is a
     * stack-adjacent string written for a log rather than for a reader. The
     * engine's own failures never take this path.
     */
    onError: (error) => {
      console.error("[chat] stream failed", error);
      return "That answer could not be completed. Try asking again.";
    },
  });

  return createUIMessageStreamResponse({ stream });
}
