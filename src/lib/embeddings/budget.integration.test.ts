import { AutoTokenizer } from "@huggingface/transformers";
import { describe, expect, it, vi } from "vitest";

import { CHUNKING, chunkDocument, embeddingText } from "@/lib/ingest/chunk";

import { createLocalEmbeddingProvider } from "./local";

/**
 * DOES THE AUGMENTED CHUNK ACTUALLY FIT IN THE MODEL?
 *
 * `CHUNKING.targetTokens` is denominated in cl100k tokens, because that is what
 * a fast synchronous tokenizer gives us at chunk time. The constraint it exists
 * to satisfy is denominated in WordPiece tokens, because that is what
 * bge-small-en-v1.5 actually encodes with, and its 512-token sequence limit is
 * hard. The two counts are related by an empirical ratio, not an identity, so
 * the budget rests on an assumption that has to be measured against the real
 * tokenizer or it is worth nothing.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT THE MEASUREMENT SAYS
 *
 *   WordPiece-per-cl100k ratio, English legal prose ....... 1.19
 *   context header for a deep three-level breadcrumb ...... 58 tokens
 *   worst augmented chunk at 300 / 380 / 70 .............. 462 / 512
 *
 * THE CEILING IS THE NUMBER THAT MEETS THE LIMIT, NOT THE TARGET. A stored
 * chunk is not `targetTokens` long: the packer fills to `maxTokens`, the merge
 * pass can add `minTokens` on top, and the overlap adds up to twice its own
 * budget again. That is how an earlier 350/450/80 budget measured 563 and
 * overshot while its target still looked comfortably small — which is exactly
 * the kind of arithmetic that is convincing on paper and wrong in practice, and
 * exactly why this file exists.
 *
 * The first test is the guard on the budget. The second is the guard on the
 * guard: truncation must be LOUD whatever the budget is set to, so that a
 * future retune that crosses the line shows up in logs rather than only as
 * quietly worse retrieval.
 * ───────────────────────────────────────────────────────────────────────────
 */

const skip = process.env.SKIP_MODEL_TESTS === "1";

/** The model's own limit. Not ours to choose. */
const SEQUENCE_LIMIT = 512;

const MODEL = process.env.EMBEDDING_MODEL ?? "Xenova/bge-small-en-v1.5";

/**
 * A worst case, not an average one: long title, deep nested headings, and
 * dense clause-heavy prose — everything that inflates the context header and
 * the tokens-per-character ratio at the same time.
 */
function buildWorstCaseDocument(): { title: string; text: string } {
  const title =
    "Master Services and Data Processing Agreement between Northfield " +
    "Analytics Limited and the Customer, 2026 revision";

  const clause = (n: number) =>
    `${n}. Notwithstanding anything to the contrary in this Agreement, the ` +
    `Provider shall not be liable for any indirect, incidental, special, ` +
    `consequential or punitive damages, including without limitation loss of ` +
    `profits, revenue, data, or business opportunity, arising out of or in ` +
    `connection with the performance or non-performance of its obligations ` +
    `under clause ${n}.${n} of Schedule B, whether in contract, tort ` +
    `(including negligence), strict liability or otherwise, even if advised ` +
    `of the possibility of such damages.`;

  const parts: string[] = [
    "# Master Services and Data Processing Agreement",
    "## Article 14 - Limitation of Liability and Indemnification",
    "### 14.7 Exclusions from the liability cap and carve-outs for wilful misconduct",
  ];
  for (let i = 1; i <= 60; i += 1) parts.push(clause(i));

  return { title, text: parts.join("\n\n") };
}

function augmentedChunks(): string[] {
  const { title, text } = buildWorstCaseDocument();
  const chunks = chunkDocument({
    text,
    pages: [{ pageNumber: 1, charStart: 0, charEnd: text.length }],
  });
  expect(chunks.length).toBeGreaterThan(3);
  return chunks.map((chunk) => embeddingText(chunk, title));
}

async function wordPieceLengths(texts: string[]): Promise<number[]> {
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL);
  return texts.map(
    (text) =>
      tokenizer(text, { truncation: false, padding: false }).input_ids.dims.at(
        -1,
      ) as number,
  );
}

describe.skipIf(skip)("chunk budget against the model's sequence limit", () => {
  it("keeps every augmented chunk inside the 512-token limit", async () => {
    const texts = augmentedChunks();
    const lengths = await wordPieceLengths(texts);
    const longest = Math.max(...lengths);

    console.info(
      `[budget] ${texts.length} chunks | longest ${longest}/${SEQUENCE_LIMIT} ` +
        `WordPiece | cl100k target ${CHUNKING.targetTokens} max ` +
        `${CHUNKING.maxTokens} min ${CHUNKING.minTokens}`,
    );

    // THE ASSERTION. Nothing is truncated, so no vector is missing its tail.
    expect(longest).toBeLessThanOrEqual(SEQUENCE_LIMIT);

    // With real headroom, so a denser document — a table of figures, a
    // non-English passage — does not quietly cross the line.
    expect(longest).toBeLessThanOrEqual(SEQUENCE_LIMIT * 0.95);
  }, 300_000);

  it("embeds the whole corpus without a truncation warning", async () => {
    // The budget above is checked with a standalone tokenizer; this checks the
    // same thing through the provider that will actually do it in production,
    // and asserts the absence of the alarm rather than the presence of a
    // number. Belt and braces on the one failure that has no symptom.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await createLocalEmbeddingProvider().embedDocuments(augmentedChunks());

      const truncations = warn.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.includes("TRUNCATION"));

      expect(truncations).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  }, 300_000);

  it("still shouts if something does exceed the limit", async () => {
    // The guard on the guard. If this stops firing, the test above becomes
    // meaningless — it would pass on a broken alarm just as happily as on a
    // correct budget. Fed something unambiguously over the line on purpose.
    const oversized = Array.from(
      { length: 400 },
      (_, i) =>
        `Clause ${i + 1} of the agreement concerns the delivery of services.`,
    ).join(" ");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await createLocalEmbeddingProvider().embedDocuments([oversized]);

      const truncations = warn.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.includes("TRUNCATION"));

      expect(truncations.length).toBe(1);
      expect(truncations[0]).toContain("512-token limit");
    } finally {
      warn.mockRestore();
    }
  }, 300_000);
});
