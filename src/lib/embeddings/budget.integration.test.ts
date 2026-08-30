import { AutoTokenizer } from "@huggingface/transformers";
import { describe, expect, it, vi } from "vitest";

import { CHUNKING, chunkDocument, embeddingText } from "@/lib/ingest/chunk";

import { createLocalEmbeddingProvider } from "./local";

/**
 * DOES THE AUGMENTED CHUNK ACTUALLY FIT IN THE MODEL?
 *
 * `CHUNKING.targetTokens` is denominated in cl100k tokens, because that is what
 * a fast synchronous tokenizer gives us at chunk time. The constraint it is
 * meant to satisfy is denominated in WordPiece tokens, because that is what
 * bge-small-en-v1.5 actually encodes with, and its 512-token sequence limit is
 * hard. The two counts are related by an empirical ratio, not an identity, so
 * the budget rests on an assumption that has to be measured against the real
 * tokenizer or it is worth nothing.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT THE MEASUREMENT SAYS, as of this commit
 *
 *   WordPiece-per-cl100k ratio, English legal prose ....... 1.19
 *   Context header for a deep three-level breadcrumb ...... 58 tokens
 *
 *   target 350 / max 450 / min 80 ... worst augmented chunk 563 / 512  OVER
 *   target 300 / max 380 / min 70 ... worst augmented chunk 462 / 512  fits
 *
 * The configured budget OVERSHOOTS. The reason is that a stored chunk is not
 * `targetTokens` long: the packer may fill to `maxTokens`, the merge pass may
 * add up to `minTokens` on top of that, and the overlap adds up to twice its
 * own budget again. 450 + 80 + 106 = 636 cl100k in the worst case, which is
 * 757 WordPiece — and even a plain `maxTokens` chunk is 450 x 1.19 = 536 before
 * the header is prepended.
 *
 * The numbers are left as configured because they are a deliberate choice about
 * passage size, not an accident. What is NOT left alone is the silence: the
 * local provider now measures every batch with the model's own tokenizer and
 * logs a truncation warning naming the offending lengths. The first test below
 * is what keeps that promise honest; the second records the nearest budget that
 * satisfies the 512 bound outright, so adopting it is a one-line edit against a
 * verified number rather than another guess.
 * ───────────────────────────────────────────────────────────────────────────
 */

const skip = process.env.SKIP_MODEL_TESTS === "1";

/** The model's own limit. Not ours to choose. */
const SEQUENCE_LIMIT = 512;

const MODEL = process.env.EMBEDDING_MODEL ?? "Xenova/bge-small-en-v1.5";

/**
 * The budget that measurement shows does fit, including the header and the
 * worst-case overlap-plus-merge tail. Kept here as a tested fact.
 */
const VERIFIED_SAFE_BUDGET = {
  targetTokens: 300,
  maxTokens: 380,
  minTokens: 70,
} as const;

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

function augmentedChunks(options?: {
  targetTokens: number;
  maxTokens: number;
  minTokens: number;
}): string[] {
  const { title, text } = buildWorstCaseDocument();
  const chunks = chunkDocument({
    text,
    pages: [{ pageNumber: 1, charStart: 0, charEnd: text.length }],
    options,
  });
  expect(chunks.length).toBeGreaterThan(3);
  return chunks.map((chunk) => embeddingText(chunk, title));
}

describe.skipIf(skip)("chunk budget against the model's sequence limit", () => {
  it("never truncates silently — the provider names what it had to cut", async () => {
    // THE INVARIANT THAT ACTUALLY HOLDS. Whatever the budget is set to, a
    // passage that exceeds the model's limit must produce a visible warning
    // rather than a quietly shortened vector. Silent truncation is the failure
    // mode with no symptom: the stored text still shows the tail, the vector
    // no longer contains it, and retrieval degrades with nothing to point at.
    const tokenizer = await AutoTokenizer.from_pretrained(MODEL);
    const texts = augmentedChunks();

    const lengths = texts.map(
      (text) =>
        tokenizer(text, { truncation: false, padding: false }).input_ids.dims.at(
          -1,
        ) as number,
    );
    const longest = Math.max(...lengths);
    const overLimit = lengths.filter((n) => n > SEQUENCE_LIMIT).length;

    console.info(
      `[budget] ${texts.length} chunks | longest ${longest}/${SEQUENCE_LIMIT} ` +
        `WordPiece | ${overLimit} over | cl100k target ${CHUNKING.targetTokens} ` +
        `max ${CHUNKING.maxTokens} min ${CHUNKING.minTokens}`,
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await createLocalEmbeddingProvider().embedDocuments(texts);

      const warnings = warn.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.includes("TRUNCATION"));

      if (overLimit > 0) {
        // Over the limit: the alarm must have fired, and must say how far over.
        expect(warnings.length).toBeGreaterThan(0);
        expect(warnings.join(" ")).toContain(String(longest));
      } else {
        // Within the limit: no false alarms.
        expect(warnings).toEqual([]);
      }
    } finally {
      warn.mockRestore();
    }
  }, 300_000);

  it("fits inside the limit at the verified-safe budget", async () => {
    // The nearest budget that satisfies the 512 bound outright, measured rather
    // than estimated. If CHUNKING is ever retuned to these numbers this test
    // becomes the regression guard for it; until then it is the evidence that
    // they work.
    const tokenizer = await AutoTokenizer.from_pretrained(MODEL);
    const texts = augmentedChunks(VERIFIED_SAFE_BUDGET);

    const lengths = texts.map(
      (text) =>
        tokenizer(text, { truncation: false, padding: false }).input_ids.dims.at(
          -1,
        ) as number,
    );
    const longest = Math.max(...lengths);

    console.info(
      `[budget] verified-safe (${VERIFIED_SAFE_BUDGET.targetTokens}/` +
        `${VERIFIED_SAFE_BUDGET.maxTokens}/${VERIFIED_SAFE_BUDGET.minTokens}): ` +
        `${texts.length} chunks | longest ${longest}/${SEQUENCE_LIMIT} WordPiece`,
    );

    expect(longest).toBeLessThanOrEqual(SEQUENCE_LIMIT);
    // With real headroom, so a denser document does not quietly cross the line.
    expect(longest).toBeLessThanOrEqual(SEQUENCE_LIMIT * 0.95);
  }, 300_000);
});
