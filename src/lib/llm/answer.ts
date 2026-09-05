import { and, eq, inArray, isNull } from "drizzle-orm";

import { db } from "@/db";
import { citations, documents, messages, retrievals } from "@/db/schema";
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
 * THE COST FIELD IS ZERO AND THAT IS A MEASUREMENT
 *
 * `costCents` is written as 0 because every model in the pool is a `:free`
 * OpenRouter variant, validated at boot, whose prompt and completion prices are
 * literally `0`. That is the real number, not a placeholder and not an estimate
 * standing in for one — which is why nothing here tries to compute a notional
 * price from token counts. Tokens and latency are recorded because those ARE
 * real and are what would turn into money first if this ever moved off the free
 * pool.
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
   *     given an empty context spends a request from a shared 200/day quota
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
      latencyMs: Date.now() - startedAt,
      finishReason: "no-context",
    });

    await persistTrace({ messageId, candidates, citations: [] });

    yield { type: "start", passages: [], model: "none" };
    yield { type: "text", delta: text };
    yield { type: "citations", citations: [] };
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
  const failures: unknown[] = [];

  for (const modelId of pool) {
    let emitted = false;
    text = "";

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
        text += delta;
        yield { type: "text", delta };
      }

      served = modelId;
      break;
    } catch (error) {
      if (signal?.aborted) {
        // The user navigated away or hit stop. Not a failure to report, and
        // certainly not a reason to spend another model on a dead request.
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

  const messageId = await persistMessage({
    conversationId,
    content: validation.text,
    // The model that ACTUALLY served this, which is not necessarily the
    // configured one. Recording the configured model would make the trace lie
    // on exactly the requests where knowing the truth matters.
    model: served,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    latencyMs,
    finishReason: usage.finishReason,
  });

  await persistTrace({ messageId, candidates, citations: validation.citations });

  yield { type: "citations", citations: validation.citations };
  yield {
    type: "done",
    message: {
      messageId,
      model: served,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      // See the header: zero because it IS zero.
      costCents: 0,
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
      // Integer cents, and genuinely zero on the free pool.
      costCents: 0,
      latencyMs: input.latencyMs,
      finishReason: input.finishReason,
    })
    .returning({ id: messages.id });

  return row.id;
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
