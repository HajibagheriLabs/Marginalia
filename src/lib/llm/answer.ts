import { and, eq, inArray, isNull } from "drizzle-orm";

import { db } from "@/db";
import { citations, documents, messages, retrievals } from "@/db/schema";
import { freePoolNotice } from "@/lib/limits";
import { countFreePoolRequest } from "@/lib/rate-limit";
import { completionCostCents, recordCompletionUsage } from "@/lib/usage";
import {
  RetrievalError,
  retrieve,
  type RetrievalCandidate,
  type RetrievedPassage,
} from "@/lib/retrieval";

import { validateCitations, type CitationRecord } from "./citations";
import { buildUserPrompt } from "./context";
import {
  classifyFailure,
  isFailoverWorthy,
  modelPool,
  poolFailureMessage,
} from "./models";
import { buildSystemPrompt, noContextAnswer } from "./prompt";
import { createModelRunner } from "./runner";
import {
  AnswerError,
  type AnswerEvent,
  type AnswerParams,
  type AnswerSummary,
  type ModelRunner,
} from "./types";

/**
 * THE ANSWER ENGINE.
 *
 *   question
 *     → preflight: documents selected? ingested? in scope?
 *     → retrieve (hybrid, filtered, traced)
 *     → nothing above the floor?  answer WITHOUT calling a model
 *     → stream, failing over across the free pool
 *     → validate markers, strip invented ones, log the violation
 *     → persist message + citations + the full retrieval trace
 *
 * Yields `AnswerEvent`s so the caller can forward them to the client as they
 * arrive. Everything that can fail produces a SPECIFIC message — see the
 * preflight section for why a generic error is worse than useless here.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE COST FIELD IS ZERO, AND IT IS LOOKED UP RATHER THAN ASSUMED
 *
 * `costCents` comes out of the price table in src/lib/usage/pricing.ts, and on
 * this pool it is 0 — every model is a `:free` OpenRouter variant, validated at
 * boot, whose prompt and completion prices are literally zero. That is the real
 * number, not a placeholder and not an estimate standing in for one.
 *
 * It is nonetheless COMPUTED rather than typed as a literal here. Writing `0`
 * at this call site would work today and would be the single thing that makes
 * moving to a paid model unsafe tomorrow: cost would silently stay zero on
 * every message row and in every usage event, and nothing would fail. Going
 * through the table means that day is a data change in one file.
 *
 * Tokens and latency are recorded because those ARE real, and they are what
 * would turn into money first if this ever left the free pool.
 */

/** Persisted alongside the answer so the trace survives the request. */
interface PersistInput {
  messageId: string;
  candidates: RetrievalCandidate[];
  citations: CitationRecord[];
}

export async function* answer(
  params: AnswerParams,
): AsyncGenerator<AnswerEvent> {
  const { userId, conversationId, documentIds, question, signal, deps } = params;
  const startedAt = Date.now();

  /* ── PREFLIGHT ─────────────────────────────────────────────────────────
   * Each of these gets its own message. "Something went wrong" would be
   * technically true for all three and useful for none: one is fixed by
   * selecting a document, one by waiting, and one by rephrasing. A shared
   * error message would leave the user guessing which.
   */
  if (documentIds.length === 0) {
    yield {
      type: "error",
      message:
        "No documents are selected. Choose at least one from the library to ask about.",
    };
    return;
  }

  const scope = await loadScope(userId, documentIds);

  if (scope.length !== documentIds.length) {
    yield {
      type: "error",
      message:
        "Some of the selected documents are no longer available. Refresh and try again.",
    };
    return;
  }

  const notReady = scope.filter((document) => document.status !== "ready");
  if (notReady.length > 0) {
    const failed = notReady.filter((document) => document.status === "failed");
    yield {
      type: "error",
      message:
        failed.length > 0
          ? `"${failed[0].title}" could not be processed, so it cannot be searched. Open it to retry.`
          : `"${notReady[0].title}" is still being processed. It becomes searchable when indexing finishes.`,
    };
    return;
  }

  /* ── RETRIEVE ──────────────────────────────────────────────────────────── */
  let passages: RetrievedPassage[];
  let candidates: RetrievalCandidate[];

  if (deps?.retrieval) {
    ({ passages, candidates } = deps.retrieval);
  } else {
    try {
      const result = await retrieve({
        userId,
        documentIds,
        query: question,
      });
      passages = result.passages;
      candidates = result.candidates;
    } catch (error) {
      // RetrievalError messages are written for the user — a mixed embedding
      // space names the fix, an empty scope names what to do.
      if (error instanceof RetrievalError) {
        yield { type: "error", message: error.message };
        return;
      }
      throw error;
    }
  }

  /* ── THE SHORT CIRCUIT ─────────────────────────────────────────────────
   * Nothing cleared the relevance floor, so there is no context. Answering
   * this WITHOUT calling a model is not an optimisation:
   *
   *   - The answer is already known. Asking a model to say "I don't know"
   *     given an empty context spends a request from a shared 50/day quota
   *     to produce a sentence written in prompt.ts.
   *   - It cannot go wrong. A model handed no passages sometimes answers from
   *     its own knowledge anyway, and that answer would be ungrounded,
   *     uncitable, and indistinguishable from a real one.
   *
   * The message row is still written, still linked to its (empty) trace, so
   * the conversation reads correctly and the retrieval table shows what was
   * searched and rejected.
   */
  if (passages.length === 0) {
    const text = noContextAnswer(documentIds.length);
    const messageId = await persistMessage({
      conversationId,
      content: text,
      model: null,
      promptTokens: null,
      completionTokens: null,
      // No model was called, so there is nothing to price. Zero here is the
      // absence of a request, not a free one.
      costCents: 0,
      latencyMs: Date.now() - startedAt,
      finishReason: "no-context",
    });

    await persistTrace({ messageId, candidates, citations: [] });

    yield { type: "start", passages: [], model: "none" };
    yield { type: "text", delta: text };
    yield { type: "citations", citations: [] };
    // Still sent, and still worth expanding: an empty final context with a
    // full candidate list is exactly how "these documents don't answer that"
    // is explained.
    yield { type: "trace", candidates };
    yield {
      type: "done",
      message: {
        messageId,
        model: null,
        promptTokens: null,
        completionTokens: null,
        costCents: 0,
        latencyMs: Date.now() - startedAt,
        finishReason: "no-context",
        invalidMarkers: [],
      },
    };
    return;
  }

  /* ── GENERATE, WITH FAILOVER ───────────────────────────────────────────── */
  const runner = deps?.runner ?? createModelRunner();
  const pool = deps?.models ?? modelPool();
  const system = buildSystemPrompt(passages.length);
  const prompt = buildUserPrompt(passages, question);

  let served: string | null = null;
  let text = "";
  let announced = false;
  /**
   * True once a model has put text on the reader's screen.
   *
   * Survives the loop because the two ways generation can fail need two
   * different sentences, and after the loop there is nothing else to tell them
   * apart. See the branch below.
   */
  let streamedPartially = false;
  const failures: unknown[] = [];

  for (const modelId of pool) {
    let emitted = false;
    text = "";

    /*
     * ONE SLOT OF THE SHARED FREE-TIER QUOTA, TAKEN PER ATTEMPT.
     *
     * Counted here rather than once per question because failover makes more
     * than one request: a delisted primary followed by a working fallback is
     * TWO calls against OpenRouter's ~20/min and 50/day, and counting the
     * question would under-report by exactly the amount that matters on a bad
     * day. The route pre-checks the same counters before it starts the stream,
     * which is where a user gets the dialog; this is where the number stays
     * true.
     *
     * Refusing here is not an error and is never reported as one — the pool is
     * spent, the sentence says so, and it names the reset time. There is
     * deliberately no branch that reaches for a metered model instead.
     */
    if (!deps?.runner) {
      const slot = countFreePoolRequest();
      if (!slot.ok) {
        const notice = freePoolNotice(
          slot.scope ?? "day",
          slot.scope === "minute" ? slot.usedThisMinute : slot.usedToday,
          slot.resetAt,
        );
        yield {
          type: "error",
          message: `${notice.title}. ${notice.nextStep}`,
        };
        return;
      }
    }

    try {
      for await (const delta of runner.stream({
        modelId,
        system,
        prompt,
        signal,
      })) {
        if (!announced) {
          // Held until the first token so a model that fails immediately can be
          // swapped without the client ever having been told its name.
          yield { type: "start", passages, model: modelId };
          announced = true;
        }
        emitted = true;
        streamedPartially = true;
        text += delta;
        yield { type: "text", delta };
      }

      served = modelId;
      break;
    } catch (error) {
      if (signal?.aborted) {
        /*
         * THE USER PRESSED STOP, or closed the tab.
         *
         * Not a failure to report, and certainly not a reason to spend another
         * model on a dead request. But it is also not nothing: the question is
         * already a row, and returning here without writing an answer would
         * leave that question permanently unanswered in the thread, which on
         * reload looks like the app lost the reply rather than like the user
         * stopped it.
         *
         * So the partial text is persisted with `finish_reason = 'aborted'`,
         * along with its retrieval trace. The row says exactly what happened.
         * The client is already gone, so nothing is yielded — this is
         * bookkeeping for the next time the thread is opened.
         */
        await persistAborted({
          conversationId,
          userId,
          model: modelId,
          text,
          latencyMs: Date.now() - startedAt,
          candidates,
        });
        return;
      }

      failures.push(error);

      // ONCE TOKENS HAVE REACHED THE CLIENT, FAILOVER IS OFF THE TABLE. The
      // text is already on screen; restarting on another model would either
      // duplicate it or replace it mid-sentence. This is why `start` is held
      // until the first delta — the overwhelming majority of pool failures
      // (404 delisted, 429 rate limited, 5xx) happen before any token, where
      // switching is invisible.
      if (emitted || !isFailoverWorthy(error)) break;

      console.warn(
        `[llm] ${modelId} failed, trying the next free model`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  if (served === null) {
    /*
     * TWO DIFFERENT FAILURES, TWO DIFFERENT SENTENCES.
     *
     * A stream that produced tokens and then stopped is NOT an exhausted pool.
     * Failover was declined on purpose — the text is already on screen and
     * restarting on another model would duplicate or replace it mid-sentence —
     * so exactly one model was tried, and it worked until it did not.
     *
     * Reporting that as `poolFailureMessage` was wrong in both directions: it
     * logged "every model in the pool failed" when most had not been asked, and
     * it told the READER to go and check OPENROUTER_MODEL and
     * OPENROUTER_FALLBACK_MODELS — operator instructions, in a chat pane, for a
     * transient drop whose actual remedy is the retry button already next to it.
     *
     * The partial text is deliberately not persisted, which is why the sentence
     * says "ask again" rather than "reload": there is nothing to come back to.
     */
    if (streamedPartially) {
      console.warn(
        `[llm] ${pool[0]} stopped partway through an answer; no failover once tokens have shipped`,
        failures.map((error) =>
          error instanceof Error ? error.message : String(error),
        ),
      );
      yield {
        type: "error",
        message:
          "That answer stopped partway through and was not saved. Ask again to start over.",
      };
      return;
    }

    const message = poolFailureMessage(classifyFailure(failures));
    console.error(
      `[llm] every model in the pool failed (${pool.join(", ")})`,
      failures.map((error) =>
        error instanceof Error ? error.message : String(error),
      ),
    );
    yield { type: "error", message };
    return;
  }

  /* ── VALIDATE ──────────────────────────────────────────────────────────── */
  const validation = validateCitations(text, passages);

  if (validation.invalidMarkers.length > 0) {
    // A FAITHFULNESS VIOLATION, not a formatting problem. Logged with enough
    // to find it again: which model, which markers, how many passages existed.
    console.warn(
      `[llm] faithfulness violation — ${served} cited ` +
        `${validation.invalidMarkers.map((m) => `[${m}]`).join(", ")} ` +
        `with only ${passages.length} passages retrieved; markers stripped`,
    );
  }

  const usage = runner.lastUsage();
  const latencyMs = Date.now() - startedAt;

  // From the price table, not from a literal. Zero on this pool, and zero
  // because the table says the model is priced at zero — see the header.
  const costCents =
    completionCostCents({
      model: served,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
    }) ?? 0;

  const messageId = await persistMessage({
    conversationId,
    content: validation.text,
    // The model that ACTUALLY served this, which is not necessarily the
    // configured one. Recording the configured model would make the trace lie
    // on exactly the requests where knowing the truth matters.
    model: served,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    costCents,
    latencyMs,
    finishReason: usage.finishReason,
  });

  await persistTrace({ messageId, candidates, citations: validation.citations });

  // THE METER. One `usage_events` row per answer, priced by the same table and
  // attributed to the model that actually served it. Metering never fails the
  // answer it measures — see src/lib/usage/record.ts.
  await recordCompletionUsage({
    userId,
    model: served,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    latencyMs,
  });

  yield { type: "citations", citations: validation.citations };
  yield { type: "trace", candidates };
  yield {
    type: "done",
    message: {
      messageId,
      model: served,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      costCents,
      latencyMs,
      finishReason: usage.finishReason,
      invalidMarkers: validation.invalidMarkers,
    },
  };
}

/* ========================================================================== *
 * PERSISTENCE
 * ========================================================================== */

async function loadScope(userId: string, documentIds: string[]) {
  return db
    .select({
      id: documents.id,
      title: documents.title,
      status: documents.status,
    })
    .from(documents)
    .where(
      and(
        inArray(documents.id, documentIds),
        eq(documents.userId, userId),
        isNull(documents.deletedAt),
      ),
    );
}

async function persistMessage(input: {
  conversationId: string;
  content: string;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  /** Integer cents, from the price table. Genuinely zero on the free pool. */
  costCents: number;
  latencyMs: number;
  finishReason: string | null;
}): Promise<string> {
  const [row] = await db
    .insert(messages)
    .values({
      conversationId: input.conversationId,
      role: "assistant",
      content: input.content,
      model: input.model,
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      costCents: input.costCents,
      latencyMs: input.latencyMs,
      finishReason: input.finishReason,
    })
    .returning({ id: messages.id });

  return row.id;
}

/**
 * Record a generation the user stopped.
 *
 * `finish_reason` is 'aborted', which is what makes this row honest: the
 * content is whatever had arrived, it is not a complete answer, and nothing
 * downstream should treat it as one. The retrieval trace is kept because the
 * search really did happen and really did cost the work it cost.
 *
 * CITATIONS ARE DELIBERATELY NOT WRITTEN. Marker validation runs over a
 * finished answer; half a sentence can hold half a marker, and persisting
 * citations parsed out of a truncated text would either invent a link or
 * discard a real one. The partial text keeps its markers as characters and
 * gains no chips — which reads correctly, because the answer was interrupted.
 *
 * Metered like any other completion: the tokens were generated and, on a paid
 * model, would have been billed. Stopping a stream stops the generation; it
 * does not refund what was already produced.
 */
async function persistAborted(input: {
  conversationId: string;
  userId: string;
  model: string;
  text: string;
  latencyMs: number;
  candidates: RetrievalCandidate[];
}): Promise<void> {
  try {
    const messageId = await persistMessage({
      conversationId: input.conversationId,
      content: input.text,
      model: input.model,
      promptTokens: null,
      completionTokens: null,
      costCents: 0,
      latencyMs: input.latencyMs,
      finishReason: "aborted",
    });

    await persistTrace({
      messageId,
      candidates: input.candidates,
      citations: [],
    });

    await recordCompletionUsage({
      userId: input.userId,
      model: input.model,
      promptTokens: null,
      completionTokens: null,
      latencyMs: input.latencyMs,
    });
  } catch (error) {
    // The client is already gone. A failure to write the record of a cancelled
    // answer must not become an unhandled rejection in a request nobody is
    // reading.
    console.error("[llm] failed to record an aborted answer", error);
  }
}

/**
 * Write the citations and the full candidate list.
 *
 * BOTH, in one transaction, and the candidate list is the whole trace rather
 * than only the passages that were used. The rows that lost are the
 * interesting ones: "Show retrieval" exists to explain a disappointing answer,
 * and an answer is disappointing precisely when the right passage was found
 * and ranked fourth.
 */
async function persistTrace(input: PersistInput): Promise<void> {
  const { messageId, candidates, citations: records } = input;
  if (candidates.length === 0 && records.length === 0) return;

  await db.transaction(async (tx) => {
    if (records.length > 0) {
      await tx.insert(citations).values(
        records.map((record) => ({
          messageId,
          marker: record.marker,
          chunkId: record.chunkId,
          documentId: record.documentId,
          pageFrom: record.pageFrom,
          pageTo: record.pageTo,
          quotedText: record.quotedText,
        })),
      );
    }

    if (candidates.length > 0) {
      await tx.insert(retrievals).values(
        candidates.map((candidate) => ({
          messageId,
          chunkId: candidate.chunkId,
          denseRank: candidate.denseRank,
          denseScore: candidate.denseScore,
          lexicalRank: candidate.lexicalRank,
          lexicalScore: candidate.lexicalScore,
          rrfScore: candidate.rrfScore,
          rerankScore: candidate.rerankScore,
          used: candidate.used,
        })),
      );
    }
  });
}

export { AnswerError };
export type { AnswerSummary, ModelRunner };
