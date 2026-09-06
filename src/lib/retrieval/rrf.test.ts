import { describe, expect, it } from "vitest";

import { RRF_K, fuse } from "./rrf";

/**
 * RECIPROCAL RANK FUSION, against hand-computed values.
 *
 * The expected numbers below are written out as literal arithmetic —
 * `1 / (60 + 1) + 1 / (60 + 3)` — rather than as decimals or as a second
 * implementation of the formula. A test that recomputes the thing it is testing
 * passes whatever the code does, including the wrong thing; writing the
 * arithmetic out means the assertion fails if the formula changes, which is the
 * only reason to test a nine-line function at all.
 *
 * What actually matters here is the BEHAVIOUR the constant produces: that
 * agreement between two channels beats a single channel's confidence. That is
 * the property hybrid search is bought for, and it is asserted directly.
 */

const id = (n: number) => `chunk-${n}`;

describe("RRF", () => {
  it("scores a single list as 1/(k + rank)", () => {
    const fused = fuse([{ ids: [id(1), id(2), id(3)] }]);

    expect(fused.map((entry) => entry.id)).toEqual([id(1), id(2), id(3)]);
    expect(fused[0].score).toBeCloseTo(1 / (RRF_K + 1), 12);
    expect(fused[1].score).toBeCloseTo(1 / (RRF_K + 2), 12);
    expect(fused[2].score).toBeCloseTo(1 / (RRF_K + 3), 12);
  });

  it("sums reciprocal ranks across both channels", () => {
    //  dense:   A(1) B(2) C(3)
    //  lexical: C(1) A(2) D(3)
    const dense = { ids: ["A", "B", "C"] };
    const lexical = { ids: ["C", "A", "D"] };

    const fused = fuse([dense, lexical]);
    const score = (target: string) =>
      fused.find((entry) => entry.id === target)!.score;

    // A: dense 1, lexical 2
    expect(score("A")).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 2), 12);
    // C: dense 3, lexical 1
    expect(score("C")).toBeCloseTo(1 / (RRF_K + 3) + 1 / (RRF_K + 1), 12);
    // B: dense only
    expect(score("B")).toBeCloseTo(1 / (RRF_K + 2), 12);
    // D: lexical only
    expect(score("D")).toBeCloseTo(1 / (RRF_K + 3), 12);

    // A and C both appear twice; A is 1+2 and C is 3+1, so A edges it.
    expect(fused.map((entry) => entry.id)).toEqual(["A", "C", "B", "D"]);
  });

  it("records the per-channel ranks, with null for a channel that missed", () => {
    const fused = fuse([{ ids: ["A", "B"] }, { ids: ["B", "C"] }]);
    const ranks = (target: string) =>
      fused.find((entry) => entry.id === target)!.ranks;

    expect(ranks("A")).toEqual([1, null]);
    expect(ranks("B")).toEqual([2, 1]);
    expect(ranks("C")).toEqual([null, 2]);
  });

  /* ====================================================================== *
   * THE PROPERTY THE CONSTANT EXISTS FOR
   * ====================================================================== */

  it("ranks agreement above a single channel's first place", () => {
    // THE WHOLE POINT OF K. "Third in both lists" beats "first in one list
    // only". With the naive 1/rank formula it would not: 1.0 against
    // 0.33 + 0.33 = 0.67, and fusion would collapse into whichever channel
    // shouted loudest.
    const dense = { ids: ["solo", "x", "agreed"] };
    const lexical = { ids: ["y", "z", "agreed"] };

    const fused = fuse([dense, lexical]);

    expect(fused[0].id).toBe("agreed");
    expect(fused[0].score).toBeCloseTo(2 / (RRF_K + 3), 12);
    expect(fused[1].id).toBe("solo");
    expect(fused[1].score).toBeCloseTo(1 / (RRF_K + 1), 12);

    // And the margin is real, not a rounding artefact.
    expect(fused[0].score).toBeGreaterThan(fused[1].score);
  });

  it("would rank the other way with a naive 1/rank formula", () => {
    // The counterfactual, asserted so the constant's effect is documented by a
    // failing alternative rather than by a comment alone. k=0 IS 1/rank.
    const dense = { ids: ["solo", "x", "agreed"] };
    const lexical = { ids: ["y", "z", "agreed"] };

    const naive = fuse([dense, lexical], 0);
    expect(naive[0].id).toBe("solo");
  });

  /* ====================================================================== *
   * EDGES
   * ====================================================================== */

  it("returns nothing for empty input", () => {
    expect(fuse([])).toEqual([]);
    expect(fuse([{ ids: [] }, { ids: [] }])).toEqual([]);
  });

  it("survives one channel returning nothing", () => {
    // The everyday case: a question with no exact tokens in it, so lexical
    // finds nothing and dense carries the query alone.
    const fused = fuse([{ ids: ["A", "B"] }, { ids: [] }]);

    expect(fused.map((entry) => entry.id)).toEqual(["A", "B"]);
    expect(fused[0].score).toBeCloseTo(1 / (RRF_K + 1), 12);
    expect(fused[0].ranks).toEqual([1, null]);
  });

  it("counts a repeated id once, at its best rank", () => {
    const fused = fuse([{ ids: ["A", "B", "A"] }]);

    expect(fused).toHaveLength(2);
    expect(fused.find((entry) => entry.id === "A")!.score).toBeCloseTo(
      1 / (RRF_K + 1),
      12,
    );
  });

  it("breaks ties deterministically", () => {
    // Two passages each found by one channel at the same rank score
    // identically. Without a tiebreak the order would depend on Map iteration
    // order, which would make the trace unreproducible and the eval harness
    // measure noise.
    const first = fuse([{ ids: ["b"] }, { ids: ["a"] }]);
    const second = fuse([{ ids: ["b"] }, { ids: ["a"] }]);

    expect(first[0].score).toBeCloseTo(second[0].score, 12);
    expect(first.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(second.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("honours a custom k", () => {
    const fused = fuse([{ ids: ["A"] }], 10);
    expect(fused[0].score).toBeCloseTo(1 / 11, 12);
  });
});

/* ========================================================================== *
 * CHANNEL WEIGHTS
 * ========================================================================== */

describe("channel weights", () => {
  it("defaults to 1, which is plain RRF", () => {
    // The property that makes weights safe to add: an unweighted call and an
    // explicitly-1 call must be bit-for-bit identical, or every existing score
    // in the product would shift the day this parameter appeared.
    const implicit = fuse([{ ids: ["A", "B"] }, { ids: ["B", "A"] }]);
    const explicit = fuse([
      { ids: ["A", "B"], weight: 1 },
      { ids: ["B", "A"], weight: 1 },
    ]);

    expect(implicit).toEqual(explicit);
  });

  it("multiplies a channel's contribution", () => {
    const fused = fuse([
      { ids: ["A"], weight: 2 },
      { ids: ["B"], weight: 1 },
    ]);

    expect(fused[0].id).toBe("A");
    expect(fused[0].score).toBeCloseTo(2 / (RRF_K + 1), 12);
    expect(fused[1].score).toBeCloseTo(1 / (RRF_K + 1), 12);
  });

  it("lets a weight overturn the corroboration bias", () => {
    // Plain RRF deliberately ranks a passage found by BOTH channels above one
    // found 1st by a single channel. A weight is the only knob that can express
    // "trust dense more than that" — K is shared by every list and changes the
    // curve's shape, not the balance between lists.
    //
    // The arithmetic is written out rather than trusted, because it is the
    // whole point of the test and it is not obvious how heavy a weight has to
    // be. With `corroborated` at rank 10 in both channels and `x` at rank 1 in
    // dense only:
    //
    //   equal weights   corroborated = 2/70 = 0.0286  beats  x = 1/61 = 0.0164
    //   dense weight 8  corroborated = 9/70 = 0.1286  loses to x = 8/61 = 0.1311
    //
    // Corroboration is expensive to overturn, and that is the intended bias.
    const dense = ["x", "a", "b", "c", "d", "e", "f", "g", "h", "corroborated"];
    const lexical = ["p", "q", "r", "s", "t", "u", "v", "w", "y", "corroborated"];

    const equal = fuse([{ ids: dense }, { ids: lexical }]);
    expect(equal[0].id).toBe("corroborated");

    const denseHeavy = fuse([
      { ids: dense, weight: 8 },
      { ids: lexical, weight: 1 },
    ]);
    expect(denseHeavy[0].id).toBe("x");
    expect(denseHeavy[0].score).toBeCloseTo(8 / (RRF_K + 1), 12);
  });

  it("removes a channel at weight 0 while keeping its ranks in the trace", () => {
    // How "what would dense-only do?" is measured without a second code path.
    // The lexical rank must survive: the trace is a product feature, and a
    // passage the lexical channel found at rank 1 is a fact about the search
    // whether or not it was allowed to contribute a score.
    const fused = fuse([
      { ids: ["A"], weight: 1 },
      { ids: ["B"], weight: 0 },
    ]);

    const b = fused.find((entry) => entry.id === "B")!;
    expect(b.score).toBe(0);
    expect(b.ranks).toEqual([null, 1]);
    expect(fused[0].id).toBe("A");
  });
});
