import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { z } from "zod";

import { requireConversationAccess } from "@/lib/auth-server";
import { titleFromQuestion } from "@/lib/chat/title";
import { toUITraceRow } from "@/lib/chat/trace";
import type { MarginaliaUIMessage } from "@/lib/chat/types";
import {
  setConversationTitleIfUnset,
  touchConversation,
} from "@/lib/conversations";
import {
  FREE_POOL,
  freePoolNotice,
  rateLimitNotice,
  type LimitNotice,
} from "@/lib/limits";
import { answer } from "@/lib/llm";
import { freePoolState, release, take } from "@/lib/rate-limit";
import { LimitError, insertUserMessageWithinLimit } from "@/lib/usage";

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
 * THREE CEILINGS, CHECKED BEFORE THE STREAM OPENS
 *
 *   1. A TOKEN BUCKET per user, so a loop cannot hammer the endpoint.
 *   2. THE DAILY QUESTION LIMIT, enforced by the same transaction that stores
 *      the question — see `insertUserMessageWithinLimit`.
 *   3. THE SHARED FREE-TIER MODEL QUOTA, ~20/min and ~200/day across the whole
 *      app rather than per user.
 *
 * All three refuse with a 429 carrying a `LimitNotice`, and the pane opens a
 * dialog naming the exact ceiling and the way out. They are checked HERE, up
 * front, rather than inside the stream, for one reason: once a
 * `text/event-stream` response has started, the only way to report anything is
 * an error chunk inside it, and a limit is not an error. A status code and a
 * JSON body are what a limit is.
 *
 * A limit refusal RELEASES the bucket token it took. Discovering you are at a
 * ceiling must not also spend the allowance that would let you retry once it
 * clears.
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

  /* ── 1. THE BUCKET ────────────────────────────────────────────────────── */
  const rate = take("chat", user.id);
  if (!rate.ok) {
    return refuse(rateLimitNotice("questions", rate.resetAt));
  }

  /* ── 2. THE DAILY QUESTION LIMIT ──────────────────────────────────────── */
  if (trigger === "submit-message") {
    try {
      // Counts and inserts in ONE transaction under a per-user advisory lock,
      // so two questions sent together cannot both pass the hundredth check.
      await insertUserMessageWithinLimit({
        userId: user.id,
        conversationId: conversation.id,
        content: question,
      });
    } catch (error) {
      if (error instanceof LimitError) {
        release("chat", user.id);
        return refuse(error.notice);
      }
      throw error;
    }

    // Titled once, from the first question, by a predicate inside the UPDATE —
    // see `setConversationTitleIfUnset` for why this cannot race into two
    // different titles.
    await setConversationTitleIfUnset(
      conversation.id,
      titleFromQuestion(question),
    );
  }
  // A `regenerate-message` deliberately skips the count. The question is
  // already stored and was already paid for; retrying an answer that failed is
  // not a second question.

  /* ── 3. THE SHARED FREE-TIER MODEL QUOTA ──────────────────────────────── */
  //
  // Read-only here. The slots are actually TAKEN inside the answer engine, once
  // per model attempt, because failover makes more than one request per
  // question. This peek exists so an exhausted pool produces a dialog with a
  // reset time instead of an error chunk halfway through an empty answer.
  const pool = freePoolState();
  if (pool.usedToday >= FREE_POOL.requestsPerDay) {
    release("chat", user.id);
    return refuse(freePoolNotice("day", pool.usedToday, pool.resetAt));
  }
  if (pool.usedThisMinute >= FREE_POOL.requestsPerMinute) {
    release("chat", user.id);
    return refuse(
      freePoolNotice("minute", pool.usedThisMinute, new Date(Date.now() + 60_000)),
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

      // A STREAM THE USER STOPPED GIVES ITS TOKEN BACK.
      //
      // Pressing stop is supposed to cost less, not more. The engine has
      // already written the partial answer with `finish_reason = 'aborted'`,
      // so the work is recorded; what is refunded is the rate-limit slot, so a
      // user who stops three long answers in a row can still ask a fourth.
      // The DAILY question count is not refunded — the question was asked, and
      // retrieval and generation both really ran.
      if (request.signal.aborted) release("chat", user.id);
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

/**
 * A limit, as an HTTP response.
 *
 * 429 with a JSON body carrying the whole `LimitNotice`. The AI SDK's default
 * transport throws an `Error` whose message is the raw response body on any
 * non-2xx, so the pane parses this back out and opens a dialog — which is why
 * the body is JSON and nothing else. `retry-after` is set when the limit
 * clears on its own, because that is the header a well-behaved client reads.
 */
function refuse(notice: LimitNotice): Response {
  const headers: Record<string, string> = {};
  if (notice.resetAt) {
    const seconds = Math.ceil(
      (new Date(notice.resetAt).getTime() - Date.now()) / 1000,
    );
    if (seconds > 0) headers["retry-after"] = String(seconds);
  }

  return Response.json({ error: notice.message, limit: notice }, {
    status: 429,
    headers,
  });
}
