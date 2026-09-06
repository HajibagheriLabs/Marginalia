import { describe, expect, it, vi } from "vitest";

import { createLocalReranker, getReranker } from "./rerank";

/**
 * THE CROSS-ENCODER.
 *
 * This file exists for one bug, which is invisible without it.
 *
 * The natural way to run this model is `pipeline("text-classification")`, and
 * that silently does not work: ms-marco-MiniLM is a REGRESSION cross-encoder
 * with a single output logit, and the classification pipeline applies softmax
 * across the label dimension. Softmax over one value is 1.0 — for every input.
 * Every passage scores exactly 1.0, every score ties, and the reranker becomes
 * an expensive no-op that reorders nothing while appearing to work.
 *
 * There is no error, no warning, and no shape change to notice. The only
 * symptom is that reranking stops helping, which is indistinguishable from
 * reranking not being worth it on this corpus — precisely the question the
 * flag exists to answer. A wrong answer there would be baked into a decision.
 *
 * So the property under test is not "reranking runs". It is that the scores
 * SEPARATE.
 */

const skip = process.env.SKIP_MODEL_TESTS === "1";

describe("reranker configuration", () => {
  /*
   * ON IS THE DEFAULT, AND OFF HAS TO KEEP WORKING.
   *
   * The default was flipped once measurement justified it — recall@5 86.8% ->
   * 92.1% and MRR 0.736 -> 0.788 over the answerable eval questions, at +2.1 s
   * of p50 retrieval latency. What this asserts is the pair of facts that
   * followed, because the second one is the easy one to lose: the application
   * must still run with `RETRIEVAL_RERANKER=off`, and "off" must be NULL rather
   * than a no-op scorer. The retrieval pipeline branches on that null — the
   * trace hides its rerank column and assembly applies the RRF ratio floor
   * instead of the reranker's absolute one — so a no-op object returning zeros
   * would make "off" indistinguishable from "on, and everything scored zero".
   */
  it("is on by default", () => {
    // Unset in the test environment, so this is the schema default in env.ts.
    if (process.env.RETRIEVAL_RERANKER === "off") return;
    expect(getReranker()).not.toBeNull();
  });

  it("is null, not a no-op, when switched off", () => {
    vi.stubEnv("RETRIEVAL_RERANKER", "off");
    vi.resetModules();

    // Re-imported so env.ts re-parses with the stubbed value: it validates once
    // at module load, which is the whole point of parsing at boot.
    return import("./rerank").then(({ getReranker: reload }) => {
      expect(reload()).toBeNull();
      vi.unstubAllEnvs();
      vi.resetModules();
    });
  });
});

describe.skipIf(skip)("local cross-encoder", () => {
  it("separates a relevant passage from an irrelevant one", async () => {
    const reranker = createLocalReranker();

    const query = "How much notice is required to terminate the agreement?";
    const passages = [
      // Answers the question directly.
      "Either party may terminate this agreement for convenience by giving " +
        "thirty (30) days prior written notice to the other party.",
      // Same document, same register, entirely unrelated subject.
      "The Customer shall reimburse reasonable travel expenses incurred by " +
        "the Provider's personnel, supported by itemised receipts.",
      // Mentions the topic without answering.
      "Notice periods for termination for convenience are set out in the " +
        "applicable schedule.",
    ];

    const scores = await reranker.score(query, passages);

    expect(scores).toHaveLength(3);
    for (const score of scores) expect(Number.isFinite(score)).toBe(true);

    console.info(
      `[rerank-test] ${scores.map((s) => s.toFixed(2)).join(" | ")}`,
    );

    // THE ASSERTION THIS FILE EXISTS FOR. If the classification pipeline were
    // used instead of the raw logits, all three would be exactly 1.0 and this
    // would fail — which is the only way that mistake announces itself.
    expect(new Set(scores).size).toBe(3);

    // The passage that answers the question wins, and the irrelevant one loses.
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[0]).toBeGreaterThan(scores[2]);
    expect(scores[2]).toBeGreaterThan(scores[1]);

    // Raw logits, not probabilities: the scale runs either side of zero, and
    // the assembly floor at 0 depends on that being true.
    expect(scores[0]).toBeGreaterThan(0);
    expect(scores[1]).toBeLessThan(0);
  }, 300_000);

  it("returns one score per passage, in order", async () => {
    const reranker = createLocalReranker();

    // More than one batch, so a slicing bug shows up as a misalignment rather
    // than being invisible on a short input.
    const passages = Array.from(
      { length: 11 },
      (_, i) => `Clause ${i + 1} concerns the delivery of item number ${i + 1}.`,
    );
    const scores = await reranker.score("delivery of item number 7", passages);

    expect(scores).toHaveLength(passages.length);

    // The passage naming item 7 must be the top-scoring one.
    const best = scores.indexOf(Math.max(...scores));
    expect(passages[best]).toContain("item number 7");
  }, 300_000);

  it("handles an empty candidate set", async () => {
    await expect(createLocalReranker().score("anything", [])).resolves.toEqual(
      [],
    );
  });
});
