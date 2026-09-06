import { describe, expect, it } from "vitest";

import { MODEL_PRICES, completionCostCents, formatCost, priceFor } from "./pricing";

/**
 * THE PRICE TABLE.
 *
 * Every price in it is zero today, so the interesting assertions are not about
 * arithmetic — they are about the two ways this file could fail SILENTLY the
 * day a paid model is configured:
 *
 *   1. An unknown, non-free slug priced as zero. That reads as "this answer
 *      was free" when the truth is "nobody knows what this cost", and it is
 *      the failure that shows up as an invoice rather than as a bug report.
 *   2. Rounding a real cost DOWN to zero. Under-reporting is the direction
 *      that hides money, so the arithmetic rounds up.
 *
 * Both are asserted against a hypothetical paid model rather than waiting for
 * one to exist.
 */

describe("priceFor", () => {
  it("prices every configured model", () => {
    for (const [model, price] of Object.entries(MODEL_PRICES)) {
      expect(priceFor(model)).toBe(price);
      expect(price.promptPerMillionUsd).toBe(0);
      expect(price.completionPerMillionUsd).toBe(0);
    }
  });

  it("prices any `:free` slug at zero without listing it", () => {
    // The free pool churns weekly. An exhaustive allowlist would be stale
    // within a month and would start refusing to price models that really are
    // free — the same reasoning that makes env.ts check the suffix.
    const price = priceFor("some-vendor/model-released-next-week:free");
    expect(price?.promptPerMillionUsd).toBe(0);
    expect(price?.completionPerMillionUsd).toBe(0);
  });

  it("returns null for an unknown paid slug rather than defaulting to zero", () => {
    expect(priceFor("some-vendor/expensive-model")).toBeNull();
  });

  it("returns null when no model was called", () => {
    expect(priceFor(null)).toBeNull();
  });
});

describe("completionCostCents", () => {
  it("is zero on the free pool, and that is a measurement", () => {
    expect(
      completionCostCents({
        model: "nvidia/nemotron-3.5-lightning:free",
        promptTokens: 12_000,
        completionTokens: 800,
      }),
    ).toBe(0);
  });

  it("is null for a model with no price on file", () => {
    // Distinguishable from zero on purpose: `record.ts` can then decide what
    // to store, instead of writing a zero that looks like a measurement.
    expect(
      completionCostCents({
        model: "some-vendor/expensive-model",
        promptTokens: 1_000,
        completionTokens: 1_000,
      }),
    ).toBeNull();
  });

  it("rounds a real cost UP, so accounting never under-reports", () => {
    // A hypothetical paid entry, injected the way a real one would be added:
    // two numbers in the table and nothing else changes.
    MODEL_PRICES["test/paid-model"] = {
      promptPerMillionUsd: 3,
      completionPerMillionUsd: 15,
      note: "test fixture",
    };

    try {
      // 1,000 prompt tokens at $3/M = $0.003 = 0.3 cents. Rounded up: 1 cent.
      expect(
        completionCostCents({
          model: "test/paid-model",
          promptTokens: 1_000,
          completionTokens: 0,
        }),
      ).toBe(1);

      // 1M prompt + 1M completion = $3 + $15 = $18 = 1800 cents, exactly.
      expect(
        completionCostCents({
          model: "test/paid-model",
          promptTokens: 1_000_000,
          completionTokens: 1_000_000,
        }),
      ).toBe(1800);
    } finally {
      delete MODEL_PRICES["test/paid-model"];
    }
  });

  it("treats missing token counts as zero rather than failing", () => {
    // Providers omit usage often enough that this is routine, not exceptional.
    // A missing count must not make an answer unpriceable.
    expect(
      completionCostCents({
        model: "nvidia/nemotron-3.5-lightning:free",
        promptTokens: null,
        completionTokens: null,
      }),
    ).toBe(0);
  });
});

describe("formatCost", () => {
  it("qualifies a zero so it cannot be read as a rounded fraction", () => {
    expect(formatCost(0, "nvidia/nemotron-3.5-lightning:free")).toBe("$0.00 · free tier");
  });

  it("says so when no model was called", () => {
    expect(formatCost(0, null)).toBe("$0.00 · free tier");
  });

  it("shows a plain figure once there is one", () => {
    MODEL_PRICES["test/paid-model"] = {
      promptPerMillionUsd: 3,
      completionPerMillionUsd: 15,
      note: "test fixture",
    };
    try {
      expect(formatCost(184, "test/paid-model")).toBe("$1.84");
    } finally {
      delete MODEL_PRICES["test/paid-model"];
    }
  });

  it("says the cost is unknown rather than showing a zero", () => {
    expect(formatCost(null, "some-vendor/expensive-model")).toBe("cost unknown");
  });
});
