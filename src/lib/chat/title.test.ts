import { describe, expect, it } from "vitest";

import { titleFromQuestion } from "./title";

/**
 * The failure mode this guards against is a rail full of entries that all read
 * the same — "Can you tell me…", "Can you tell me…", "Can you tell me…" — which
 * is what a naive truncation of a real question produces.
 */
describe("titleFromQuestion", () => {
  it("uses the question itself when it is already short", () => {
    expect(titleFromQuestion("What is the notice period?")).toBe(
      "What is the notice period",
    );
  });

  it("drops an opener that names no subject", () => {
    expect(
      titleFromQuestion("Can you tell me what the termination triggers are?"),
    ).toBe("What the termination triggers are");
  });

  it("collapses whitespace from a pasted, hard-wrapped question", () => {
    expect(titleFromQuestion("What   are\n  the\tpayment terms?")).toBe(
      "What are the payment terms",
    );
  });

  it("keeps only the first sentence when context precedes the question", () => {
    expect(
      titleFromQuestion(
        "I am reviewing the addendum. Does it change the notice period?",
      ),
    ).toBe("I am reviewing the addendum");
  });

  it("truncates on a word boundary and marks the cut", () => {
    const title = titleFromQuestion(
      "What obligations does the supplier have regarding the inspection and acceptance of delivered goods?",
    );
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toMatch(/\s…$/);
  });

  it("preserves capitals inside the question", () => {
    // Party names, defined terms, and part numbers are quoted exactly or not
    // at all — only the first character is ever re-cased.
    expect(titleFromQuestion("does ZX-4471-Q ship with a CE marking?")).toBe(
      "Does ZX-4471-Q ship with a CE marking",
    );
  });

  it("falls back rather than producing an empty name", () => {
    expect(titleFromQuestion("???")).toBe("New conversation");
    expect(titleFromQuestion("   ")).toBe("New conversation");
  });

  it("is deterministic — the same question always titles the same way", () => {
    const question = "What are the supplier's obligations on delivery?";
    expect(titleFromQuestion(question)).toBe(titleFromQuestion(question));
  });
});
