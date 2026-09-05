import { randomUUID } from "node:crypto";

import { APICallError } from "ai";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/db";
import {
  chunks,
  citations,
  conversations,
  documentPages,
  documents,
  messages,
  retrievals,
  users,
} from "@/db/schema";
import type { RetrievalCandidate, RetrievedPassage } from "@/lib/retrieval";

import { answer } from "./answer";
import type { AnswerEvent, ModelRunner } from "./types";

/**
 * THE ANSWER ENGINE, end to end, with a SCRIPTED MODEL.
 *
 * The model is mocked and nothing else is: real Postgres, real message rows,
 * real citation and retrieval inserts. That split is deliberate. Every property
 * worth asserting here is about what happens to a model's OUTPUT — whether an
 * invented marker survives, whether the trace matches the answer, whether a
 * request is made at all — and none of them are about the provider's wire
 * format. Mocking the AI SDK would test that this code calls the functions it
 * calls; mocking at the `ModelRunner` seam tests the behaviour.
 *
 * The counterpart is that the free-model pool's own failure handling is tested
 * through the same seam, by scripting a runner that throws the status codes
 * OpenRouter actually returns.
 */

const configured = Boolean(process.env.DATABASE_URL);

/** A runner that replays a fixed answer, and records what it was asked. */
function scriptedRunner(
  text: string,
  usage: Partial<ReturnType<ModelRunner["lastUsage"]>> = {},
): ModelRunner & { calls: Array<{ modelId: string; system: string; prompt: string }> } {
  const calls: Array<{ modelId: string; system: string; prompt: string }> = [];

  return {
    calls,
    async *stream({ modelId, system, prompt }) {
      calls.push({ modelId, system, prompt });
      // Delivered in pieces, so the caller's streaming path is exercised
      // rather than a single-chunk special case.
      for (const word of text.split(" ")) yield `${word} `;
    },
    lastUsage: () => ({
      promptTokens: usage.promptTokens ?? 1200,
      completionTokens: usage.completionTokens ?? 64,
      finishReason: usage.finishReason ?? "stop",
    }),
  };
}

/** A runner that fails the first `failures` models, then answers. */
function flakyRunner(
  failures: number,
  status: number,
  text: string,
): ModelRunner & { attempted: string[] } {
  const attempted: string[] = [];
  let seen = 0;

  return {
    attempted,
    async *stream({ modelId }) {
      attempted.push(modelId);
      if (seen < failures) {
        seen += 1;
        throw new APICallError({
          message: `simulated ${status}`,
          url: "https://openrouter.ai/api/v1/chat/completions",
          requestBodyValues: {},
          statusCode: status,
          isRetryable: status === 429,
        });
      }
      yield text;
    },
    lastUsage: () => ({
      promptTokens: 100,
      completionTokens: 10,
      finishReason: "stop",
    }),
  };
}

async function collect(
  events: AsyncGenerator<AnswerEvent>,
): Promise<AnswerEvent[]> {
  const out: AnswerEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function textOf(events: AnswerEvent[]): string {
  return events
    .filter((event) => event.type === "text")
    .map((event) => (event as { delta: string }).delta)
    .join("");
}

describe.skipIf(!configured)("answer engine", () => {
  let userId: string;
  let documentId: string;
  let conversationId: string;
  let chunkIds: string[] = [];

  /** Passages shaped exactly as retrieval would return them. */
  function passages(count: number): RetrievedPassage[] {
    return Array.from({ length: count }, (_, i) => ({
      marker: i + 1,
      chunkIds: [chunkIds[i]],
      primaryChunkId: chunkIds[i],
      documentId,
      documentTitle: "Master Services Agreement",
      text: `Passage ${i + 1}: the notice period is ${(i + 1) * 10} days.`,
      tokenCount: 20,
      pageFrom: i + 1,
      pageTo: i + 1,
      charStart: i * 100,
      charEnd: i * 100 + 50,
      sectionPath: `Article 7 › 7.${i + 1}`,
      score: 1 / (i + 1),
    }));
  }

  function candidates(count: number, used: number[]): RetrievalCandidate[] {
    return Array.from({ length: count }, (_, i) => ({
      chunkId: chunkIds[i],
      documentId,
      documentTitle: "Master Services Agreement",
      ordinal: i,
      text: `Passage ${i + 1}`,
      tokenCount: 20,
      pageFrom: i + 1,
      pageTo: i + 1,
      charStart: i * 100,
      charEnd: i * 100 + 50,
      sectionPath: null,
      denseRank: i + 1,
      denseScore: 0.9 - i * 0.05,
      lexicalRank: i === 0 ? 1 : null,
      lexicalScore: i === 0 ? 0.4 : null,
      rrfScore: 1 / (60 + i + 1),
      channel: i === 0 ? "both" : "dense",
      rerankScore: null,
      used: used.includes(i + 1),
    }));
  }

  beforeAll(async () => {
    const [user] = await db
      .insert(users)
      .values({
        name: "Answer Test",
        email: `answer-${randomUUID()}@example.test`,
        emailVerified: true,
      })
      .returning({ id: users.id });
    userId = user.id;

    const [document] = await db
      .insert(documents)
      .values({
        userId,
        title: "Master Services Agreement",
        filename: "msa.md",
        mimeType: "text/markdown",
        byteSize: 2048,
        blobUrl: "https://example.test/msa.md",
        blobPathname: `${userId}/msa.md`,
        pageCount: 3,
        status: "ready",
        chunkCount: 6,
        embeddingModel: "Xenova/bge-small-en-v1.5",
        embeddingDim: 384,
      })
      .returning({ id: documents.id });
    documentId = document.id;

    await db.insert(documentPages).values({
      documentId,
      pageNumber: 1,
      text: "page one",
      charStart: 0,
      charEnd: 8,
    });

    const inserted = await db
      .insert(chunks)
      .values(
        Array.from({ length: 6 }, (_, i) => ({
          documentId,
          ordinal: i,
          text: `Passage ${i + 1}: the notice period is ${(i + 1) * 10} days.`,
          tokenCount: 20,
          pageFrom: i + 1,
          pageTo: i + 1,
          charStart: i * 100,
          charEnd: i * 100 + 50,
          indexedAt: new Date(),
          embeddingModel: "Xenova/bge-small-en-v1.5",
        })),
      )
      .returning({ id: chunks.id });
    chunkIds = inserted.map((row) => row.id);
  }, 120_000);

  afterAll(async () => {
    if (userId) await db.delete(users).where(eq(users.id, userId));
  });

  beforeEach(async () => {
    const [conversation] = await db
      .insert(conversations)
      .values({ userId, title: "Test", documentIds: [documentId] })
      .returning({ id: conversations.id });
    conversationId = conversation.id;
  });

  /* ====================================================================== *
   * A WELL-CITED ANSWER
   * ====================================================================== */

  it("persists the citations of a well-cited answer", async () => {
    const runner = scriptedRunner(
      "The notice period is thirty days [1]. Longer terms apply elsewhere [3].",
    );

    const events = await collect(
      answer({
        userId,
        conversationId,
        documentIds: [documentId],
        question: "What is the notice period?",
        deps: {
          runner,
          models: ["test/model:free"],
          retrieval: { passages: passages(6), candidates: candidates(6, [1, 3]) },
        },
      }),
    );

    const done = events.find((event) => event.type === "done");
    expect(done).toBeDefined();
    const summary = (done as { message: { messageId: string; model: string | null; invalidMarkers: number[]; costCents: number; promptTokens: number | null } }).message;

    expect(summary.invalidMarkers).toEqual([]);
    // The model that ACTUALLY served it.
    expect(summary.model).toBe("test/model:free");
    // Zero because it IS zero on the free pool — not an estimate.
    expect(summary.costCents).toBe(0);
    expect(summary.promptTokens).toBe(1200);

    const rows = await db
      .select()
      .from(citations)
      .where(eq(citations.messageId, summary.messageId));

    expect(rows.map((row) => row.marker).sort()).toEqual([1, 3]);
    const first = rows.find((row) => row.marker === 1)!;
    expect(first.chunkId).toBe(chunkIds[0]);
    expect(first.documentId).toBe(documentId);
    expect(first.pageFrom).toBe(1);
    expect(first.quotedText).toContain("Passage 1");

    // The message row carries the model and the usage.
    const [message] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, summary.messageId));
    expect(message.role).toBe("assistant");
    expect(message.model).toBe("test/model:free");
    expect(message.costCents).toBe(0);
    expect(message.finishReason).toBe("stop");
    expect(message.latencyMs).toBeGreaterThanOrEqual(0);

    // The FULL candidate list, not only what was used.
    const trace = await db
      .select()
      .from(retrievals)
      .where(eq(retrievals.messageId, summary.messageId));
    expect(trace).toHaveLength(6);
    expect(trace.filter((row) => row.used)).toHaveLength(2);
  }, 120_000);

  it("gives the model numbered passages with their provenance", async () => {
    const runner = scriptedRunner("Answer [1].");

    await collect(
      answer({
        userId,
        conversationId,
        documentIds: [documentId],
        question: "What is the notice period?",
        deps: {
          runner,
          models: ["test/model:free"],
          retrieval: { passages: passages(3), candidates: candidates(3, [1]) },
        },
      }),
    );

    const { system, prompt } = runner.calls[0];

    // The system prompt names the exact legal range, which is what the model
    // checks itself against.
    expect(system).toContain("There are 3 numbered passages");
    expect(system).toContain("Only [1] to [3] exist");

    // Each passage carries title, section path, and pages above its text.
    expect(prompt).toContain(
      "[1] Master Services Agreement — Article 7 › 7.1 · page 1",
    );
    expect(prompt).toContain("[3] Master Services Agreement — Article 7 › 7.3");
    // Question last.
    expect(prompt.indexOf("QUESTION")).toBeGreaterThan(prompt.indexOf("[3]"));
  }, 120_000);

  /* ====================================================================== *
   * THE FAITHFULNESS VIOLATION
   * ====================================================================== */

  it("strips a marker outside the retrieved range and logs it", async () => {
    // Six passages retrieved, the model cites [9]. The claim in front of that
    // marker did not come from the documents.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const runner = scriptedRunner(
        "Notice is thirty days [1]. The fee is waived [9].",
      );

      const events = await collect(
        answer({
          userId,
          conversationId,
          documentIds: [documentId],
          question: "What is the notice period?",
          deps: {
            runner,
            models: ["test/model:free"],
            retrieval: {
              passages: passages(6),
              candidates: candidates(6, [1]),
            },
          },
        }),
      );

      const summary = (
        events.find((e) => e.type === "done") as {
          message: { messageId: string; invalidMarkers: number[] };
        }
      ).message;

      expect(summary.invalidMarkers).toEqual([9]);

      // The STORED answer no longer contains the invented marker.
      const [message] = await db
        .select()
        .from(messages)
        .where(eq(messages.id, summary.messageId));
      expect(message.content).toBe(
        "Notice is thirty days [1]. The fee is waived.",
      );
      expect(message.content).not.toContain("[9]");

      // Only the valid citation was persisted; nothing was invented to stand
      // in for the stripped one.
      const rows = await db
        .select()
        .from(citations)
        .where(eq(citations.messageId, summary.messageId));
      expect(rows.map((row) => row.marker)).toEqual([1]);

      // Logged against something findable, with the model named.
      const logged = warn.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("faithfulness violation"));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain("[9]");
      expect(logged[0]).toContain("test/model:free");
      expect(logged[0]).toContain("6 passages");
    } finally {
      warn.mockRestore();
    }
  }, 120_000);

  /* ====================================================================== *
   * THE SHORT CIRCUIT
   * ====================================================================== */

  it("answers an empty retrieval without calling the model", async () => {
    const runner = scriptedRunner("this must never be produced");

    const events = await collect(
      answer({
        userId,
        conversationId,
        documentIds: [documentId],
        question: "What does this say about maritime law?",
        deps: {
          runner,
          models: ["test/model:free"],
          // Nothing cleared the relevance floor, but candidates were still
          // found and rejected — the trace records them.
          retrieval: { passages: [], candidates: candidates(4, []) },
        },
      }),
    );

    // THE ASSERTION THIS TEST EXISTS FOR. No request was made: the answer is
    // already known, and a model handed no passages sometimes answers from its
    // own knowledge instead.
    expect(runner.calls).toHaveLength(0);

    expect(textOf(events)).toContain("Nothing in this document covers that");

    const summary = (
      events.find((e) => e.type === "done") as {
        message: { messageId: string; model: string | null; finishReason: string | null };
      }
    ).message;

    expect(summary.model).toBeNull();
    expect(summary.finishReason).toBe("no-context");

    // The message and its trace are still written, so the conversation reads
    // correctly and "Show retrieval" explains what was searched and rejected.
    const [message] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, summary.messageId));
    expect(message.model).toBeNull();

    const trace = await db
      .select()
      .from(retrievals)
      .where(eq(retrievals.messageId, summary.messageId));
    expect(trace).toHaveLength(4);
    expect(trace.every((row) => !row.used)).toBe(true);
  }, 120_000);

  /* ====================================================================== *
   * PREFLIGHT
   * ====================================================================== */

  it("refuses when no documents are selected, without retrieving", async () => {
    const runner = scriptedRunner("never");
    const events = await collect(
      answer({
        userId,
        conversationId,
        documentIds: [],
        question: "anything",
        deps: { runner, models: ["test/model:free"] },
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    expect((events[0] as { message: string }).message).toContain(
      "No documents are selected",
    );
    expect(runner.calls).toHaveLength(0);
  }, 120_000);

  it("refuses a document that is still ingesting, and names it", async () => {
    const [pending] = await db
      .insert(documents)
      .values({
        userId,
        title: "Half-Ingested Policy",
        filename: "policy.md",
        mimeType: "text/markdown",
        byteSize: 100,
        blobUrl: "https://example.test/p.md",
        blobPathname: `${userId}/p.md`,
        status: "embedding",
      })
      .returning({ id: documents.id });

    const runner = scriptedRunner("never");
    const events = await collect(
      answer({
        userId,
        conversationId,
        documentIds: [pending.id],
        question: "anything",
        deps: { runner, models: ["test/model:free"] },
      }),
    );

    expect(events[0].type).toBe("error");
    const message = (events[0] as { message: string }).message;
    expect(message).toContain("Half-Ingested Policy");
    expect(message).toContain("still being processed");
    expect(runner.calls).toHaveLength(0);

    await db.delete(documents).where(eq(documents.id, pending.id));
  }, 120_000);

  it("refuses another user's document without saying it exists", async () => {
    const events = await collect(
      answer({
        userId,
        conversationId,
        documentIds: [randomUUID()],
        question: "anything",
        deps: { runner: scriptedRunner("never"), models: ["test/model:free"] },
      }),
    );

    expect(events[0].type).toBe("error");
    expect((events[0] as { message: string }).message).toContain(
      "no longer available",
    );
  }, 120_000);

  /* ====================================================================== *
   * THE FREE MODEL POOL
   * ====================================================================== */

  it("fails over to the next free model on a 429", async () => {
    const runner = flakyRunner(2, 429, "Answered on the third model [1].");

    const events = await collect(
      answer({
        userId,
        conversationId,
        documentIds: [documentId],
        question: "What is the notice period?",
        deps: {
          runner,
          models: ["a/one:free", "b/two:free", "c/three:free"],
          retrieval: { passages: passages(2), candidates: candidates(2, [1]) },
        },
      }),
    );

    expect(runner.attempted).toEqual(["a/one:free", "b/two:free", "c/three:free"]);

    const summary = (
      events.find((e) => e.type === "done") as { message: { model: string | null } }
    ).message;
    // The model that actually served it, not the one that was configured.
    expect(summary.model).toBe("c/three:free");

    // The client was never told about the models that failed.
    const starts = events.filter((event) => event.type === "start");
    expect(starts).toHaveLength(1);
    expect((starts[0] as { model: string }).model).toBe("c/three:free");
  }, 120_000);

  it("fails over on a 404, which is how a delisted model presents", async () => {
    const runner = flakyRunner(1, 404, "Second model answered [1].");

    await collect(
      answer({
        userId,
        conversationId,
        documentIds: [documentId],
        question: "q",
        deps: {
          runner,
          models: ["gone/model:free", "alive/model:free"],
          retrieval: { passages: passages(1), candidates: candidates(1, [1]) },
        },
      }),
    );

    expect(runner.attempted).toEqual(["gone/model:free", "alive/model:free"]);
  }, 120_000);

  it("does not fail over on a 401, which every model would repeat", async () => {
    const runner = flakyRunner(3, 401, "never reached");

    const events = await collect(
      answer({
        userId,
        conversationId,
        documentIds: [documentId],
        question: "q",
        deps: {
          runner,
          models: ["a/one:free", "b/two:free"],
          retrieval: { passages: passages(1), candidates: candidates(1, [1]) },
        },
      }),
    );

    // One attempt only: a bad key is a configuration problem, and three more
    // requests would spend three slots of a shared budget to repeat it.
    expect(runner.attempted).toEqual(["a/one:free"]);
    expect(events[events.length - 1].type).toBe("error");
    expect((events[events.length - 1] as { message: string }).message).toContain(
      "OPENROUTER_API_KEY",
    );
  }, 120_000);

  it("returns a specific message when the whole pool is exhausted", async () => {
    const runner = flakyRunner(5, 429, "never reached");

    const events = await collect(
      answer({
        userId,
        conversationId,
        documentIds: [documentId],
        question: "q",
        deps: {
          runner,
          models: ["a/one:free", "b/two:free"],
          retrieval: { passages: passages(1), candidates: candidates(1, [1]) },
        },
      }),
    );

    const last = events[events.length - 1];
    expect(last.type).toBe("error");
    const message = (last as { message: string }).message;

    // Specific, actionable, and never a generic 500 — a rate limit clears in a
    // minute and the user should be told exactly that.
    expect(message).toContain("rate-limited");
    expect(message.toLowerCase()).toContain("try again in a minute");
    // And never an offer to upgrade to a paid model.
    expect(message.toLowerCase()).not.toContain("paid");

    // No message row: nothing was generated, so there is no answer to store.
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    expect(rows).toHaveLength(0);
  }, 120_000);

  it("stops quietly when the request is aborted", async () => {
    const controller = new AbortController();

    const runner: ModelRunner = {
      async *stream() {
        controller.abort();
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
      lastUsage: () => ({
        promptTokens: null,
        completionTokens: null,
        finishReason: null,
      }),
    };

    const events = await collect(
      answer({
        userId,
        conversationId,
        documentIds: [documentId],
        question: "q",
        signal: controller.signal,
        deps: {
          runner,
          models: ["a/one:free", "b/two:free"],
          retrieval: { passages: passages(1), candidates: candidates(1, [1]) },
        },
      }),
    );

    // No error event: the user cancelled, which is not a failure to report.
    expect(events.some((event) => event.type === "error")).toBe(false);
    // And no second model was tried for a request nobody is waiting on.
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    expect(rows).toHaveLength(0);
  }, 120_000);
});
