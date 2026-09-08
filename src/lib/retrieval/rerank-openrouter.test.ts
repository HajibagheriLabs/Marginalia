import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLocalReranker } from "./rerank";
import { createOpenRouterReranker, OPENROUTER_RERANK } from "./rerank-openrouter";

/**
 * THE HOSTED RERANKER, against a scripted transport.
 *
 * Two things are asserted here and both of them fail silently in production:
 *
 *   1. THE RESULTS COME BACK SORTED BY RELEVANCE, NOT BY INPUT ORDER. Verified
 *      live: a six-document request answered with indices 0, 1, 3, 2, 4, 5.
 *      Reading `results[i]` positionally attaches the best score to the first
 *      passage on every query, which ranks by input order while looking
 *      completely healthy — real scores, plausible spread, a rendered trace.
 *   2. THE SCORE SCALE IS A PROBABILITY, NOT A LOGIT. The local cross-encoder's
 *      floor of 0 is the trained boundary for a logit; applied to a (0, 1)
 *      score it admits everything and the relevance floor stops existing.
 *
 * The wire shape is Cohere's `/rerank`: `{ results: [{ index,
 * relevance_score, document }] }`.
 */

function rerankResponse(pairs: Array<[number, number]>): Response {
  return new Response(
    JSON.stringify({
      model: "nvidia/llama-nemotron-rerank-vl-1b-v2",
      // Sorted by score descending, as the gateway actually answers.
      results: [...pairs]
        .sort((a, b) => b[1] - a[1])
        .map(([index, relevance_score]) => ({
          index,
          relevance_score,
          document: { text: `passage ${index}` },
        })),
      usage: { total_tokens: 103, cost: 0 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("OpenRouter reranker", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("scatters scores back into the order the passages were given in", async () => {
    // Passage 2 is the best, passage 0 the worst — the reverse of input order,
    // so a positional read produces exactly the wrong answer.
    fetchMock.mockResolvedValue(
      rerankResponse([
        [0, 0.001],
        [1, 0.2],
        [2, 0.99],
      ]),
    );

    const scores = await createOpenRouterReranker().score("q", ["a", "b", "c"]);

    expect(scores).toEqual([0.001, 0.2, 0.99]);
  });

  it("sends the query and documents the caller passed", async () => {
    fetchMock.mockResolvedValue(rerankResponse([[0, 0.5]]));

    const reranker = createOpenRouterReranker();
    await reranker.score("how much notice?", ["thirty days"]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/rerank");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(reranker.model);
    expect(body.query).toBe("how much notice?");
    expect(body.documents).toEqual(["thirty days"]);
  });

  /**
   * A passage the gateway simply did not mention scores BELOW ANY FLOOR rather
   * than at zero. Absent is "no opinion", and defaulting it to 0 would be one
   * short of the floor for a logit scale and comfortably below it for a
   * probability — in other words, an accident either way. Making it -Infinity
   * is a decision.
   */
  it("puts an omitted passage below every floor instead of at zero", async () => {
    fetchMock.mockResolvedValue(
      rerankResponse([
        [0, 0.9],
        // index 1 is missing entirely.
        [2, 0.4],
      ]),
    );

    const scores = await createOpenRouterReranker().score("q", ["a", "b", "c"]);

    expect(scores[0]).toBe(0.9);
    expect(scores[1]).toBe(Number.NEGATIVE_INFINITY);
    expect(scores[2]).toBe(0.4);
  });

  it("ignores an out-of-range index rather than writing past the array", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            { index: 0, relevance_score: 0.7 },
            { index: 99, relevance_score: 0.9 },
            { index: -1, relevance_score: 0.9 },
            { index: 1, relevance_score: null },
          ],
        }),
        { status: 200 },
      ),
    );

    const scores = await createOpenRouterReranker().score("q", ["a", "b"]);

    expect(scores).toHaveLength(2);
    expect(scores[0]).toBe(0.7);
    expect(scores[1]).toBe(Number.NEGATIVE_INFINITY);
  });

  it("makes no call, and returns nothing, for no passages", async () => {
    expect(await createOpenRouterReranker().score("q", [])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on a gateway error so retrieval can fall back to RRF", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));

    // retrieve() catches this and keeps the fused ordering — reranking is an
    // improvement, not a requirement.
    await expect(
      createOpenRouterReranker().score("q", ["a"]),
    ).rejects.toThrow(/500/);
  });
});

/**
 * THE FLOOR BELONGS TO THE SCALE.
 *
 * These two assertions are the whole reason `scoreFloor` is on the `Reranker`
 * interface rather than being a constant in assemble.ts. If a future change
 * moves the floor back to a shared default, one of these fails.
 */
describe("rerank score floors", () => {
  it("is 0 for the local cross-encoder, which returns raw logits", () => {
    expect(createLocalReranker().scoreFloor).toBe(0);
  });

  it("is above 0 for the hosted reranker, which returns a probability", () => {
    const floor = createOpenRouterReranker().scoreFloor;

    expect(floor).toBe(OPENROUTER_RERANK.scoreFloor);
    // The load-bearing claim: a probability floor of 0 would admit every
    // passage that can ever be scored, deleting the relevance floor entirely.
    expect(floor).toBeGreaterThan(0);
    expect(floor).toBeLessThan(1);
  });

  /**
   * The measured distribution the floor sits in, asserted as a fixture so the
   * number in the code and the number in its justification cannot drift.
   * Measured against nvidia/llama-nemotron-rerank-vl-1b-v2:free — see the
   * header of rerank-openrouter.ts for the full table.
   */
  it("separates the measured relevant passages from the irrelevant ones", () => {
    const floor = OPENROUTER_RERANK.scoreFloor;

    const answersTheQuestion = 0.998;
    const relatedClause = 0.205;
    const unrelatedSameDocument = 0.0023;
    const differentDocument = 0.00012;

    expect(answersTheQuestion).toBeGreaterThan(floor);
    expect(relatedClause).toBeGreaterThan(floor);
    expect(unrelatedSameDocument).toBeLessThan(floor);
    expect(differentDocument).toBeLessThan(floor);
  });
});
