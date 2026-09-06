import { readFile } from "node:fs/promises";
import path from "node:path";

import { AutoTokenizer } from "@huggingface/transformers";
import { describe, expect, it, vi } from "vitest";

import { CHUNKING, chunkDocument, embeddingText } from "@/lib/ingest/chunk";
import { assemblePages, paginateText } from "@/lib/ingest/extract";

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
 *   WordPiece-per-cl100k, clause-heavy English legal prose ....... 1.19
 *   WordPiece-per-cl100k, dense numeric and citation prose ....... 1.44
 *   context header for a deep three-level breadcrumb ............. 58 tokens
 *   worst augmented chunk at 260 / 320 / 60 ..................... 459 / 512
 *
 * THE CEILING IS THE NUMBER THAT MEETS THE LIMIT, NOT THE TARGET. A stored
 * chunk is not `targetTokens` long: the packer fills to `maxTokens`, the merge
 * pass can add `minTokens` on top, and the overlap adds up to twice its own
 * budget again. That is how an earlier 350/450/80 budget measured 563 and
 * overshot while its target still looked comfortably small — which is exactly
 * the kind of arithmetic that is convincing on paper and wrong in practice, and
 * exactly why this file exists.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THERE ARE NOW TWO WORST CASES
 *
 * Because one was not enough, and the failure was live rather than theoretical.
 * A 300/380/70 budget measured 462/512 against the legal document below and
 * was declared safe — and then produced THIRTEEN over-limit chunks on the real
 * eval corpus, the worst at 556, because the ratio is not a constant. Legal
 * prose runs about 1.19 WordPiece per cl100k token; the clinical guideline runs
 * up to 1.44, because it is full of the things WordPiece splits hardest:
 * bracketed reference numbers, "≥50 MME/day", dosage units, section numbers.
 *
 * A budget validated only against prose is validated against the easy half of
 * the corpus. So `buildDenseNumericDocument` exists as the pessimistic case,
 * and the assertion runs over both.
 *
 * The first two tests guard the budget. The last one guards the guard:
 * truncation must be LOUD whatever the budget is set to, so a future retune
 * that crosses the line shows up in logs rather than only as quietly worse
 * retrieval.
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

/**
 * The OTHER worst case: dense numeric and citation prose.
 *
 * Modelled on the clinical guideline in evals/dataset/, which is what actually
 * broke the previous budget. Everything here is chosen because WordPiece splits
 * it far harder than it splits words: bracketed reference lists, comparison
 * operators against numbers, dosage units, and multi-part section numbers. This
 * is the shape that produces a 1.44 ratio where prose produces 1.19.
 */
function buildDenseNumericDocument(): { title: string; text: string } {
  const title =
    "Clinical Practice Guideline for Prescribing Analgesics and Adjunctive " +
    "Therapies in Ambulatory Care — United States, 2026 Update";

  const para = (n: number) =>
    `Recommendation ${n}.${n}.${n}: For patients aged ≥18 years receiving ` +
    `≥50 MME/day, clinicians should reassess within 1–4 weeks ( ${n} , ` +
    `${n + 1} , ${n + 2} – ${n + 9} ). Overdose risk is 1.9–4.6 times higher ` +
    `at 50–<100 MME/day relative to <20 MME/day ( ${n + 11} , ${n + 12} ), ` +
    `and 2.0–8.9 times higher at ≥100 MME/day ( ${n + 13} – ${n + 18} ). ` +
    `Coprescription of benzodiazepines increased adjusted odds to 3.86 ` +
    `(95% CI = 2.14–6.98; p<0.001) in a cohort of 12,847 patients ` +
    `( ${n + 19} , ${n + 20} ).`;

  const parts: string[] = [
    "# Clinical Practice Guideline for Prescribing Analgesics",
    "## Recommendations for Initiating and Continuing Opioid Therapy",
    "### 4.7.2 Dosage thresholds, tapering schedules, and risk mitigation",
  ];
  for (let i = 1; i <= 60; i += 1) parts.push(para(i));

  return { title, text: parts.join("\n\n") };
}

function augment(document: { title: string; text: string }): string[] {
  const chunks = chunkDocument({
    text: document.text,
    pages: [{ pageNumber: 1, charStart: 0, charEnd: document.text.length }],
  });
  expect(chunks.length).toBeGreaterThan(3);
  return chunks.map((chunk) => embeddingText(chunk, document.title));
}

/** Both worst cases, so the assertion covers the whole corpus, not half of it. */
function augmentedChunks(): string[] {
  return [
    ...augment(buildWorstCaseDocument()),
    ...augment(buildDenseNumericDocument()),
  ];
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

/**
 * THE REAL CORPUS, chunked exactly as ingestion chunks it.
 *
 * The three documents in evals/dataset/ are committed text with pinned
 * hashes, so this is deterministic and needs no network. It exists because the
 * two synthetic cases above are STILL more optimistic than reality: they
 * measure 381/512 where the real corpus measures 459, and it was the real
 * corpus that produced the thirteen truncated chunks nobody's hand-built
 * worst case predicted.
 *
 * A guard written from imagination measures the failures you thought of. This
 * one measures the documents the product is actually pointed at.
 */
const CORPUS = [
  ["45 CFR Part 164 — Security and Privacy (HIPAA)", "hipaa-45-cfr-164.txt"],
  [
    "CDC Clinical Practice Guideline for Prescribing Opioids for Pain — United States, 2022",
    "cdc-opioid-guideline-2022.txt",
  ],
  [
    "FAR 52.212-4 — Contract Terms and Conditions, Commercial Products and Commercial Services",
    "far-52-212-4.txt",
  ],
] as const;

async function corpusAugmentedChunks(): Promise<string[]> {
  const out: string[] = [];

  for (const [title, filename] of CORPUS) {
    const file = path.join(process.cwd(), "evals", "dataset", filename);
    const text = await readFile(file, "utf8");

    // The same two functions ingestion uses for a text upload, so the chunk
    // boundaries here are the boundaries production would produce.
    const { pages } = assemblePages(paginateText(text));
    const chunks = chunkDocument({
      text,
      pages: pages.map((page) => ({
        pageNumber: page.pageNumber,
        charStart: page.charStart,
        charEnd: page.charEnd,
      })),
    });

    for (const chunk of chunks) out.push(embeddingText(chunk, title));
  }

  return out;
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

  it("keeps every chunk of the REAL corpus inside the limit", async () => {
    // The assertion that would have caught the 300/380/70 regression. The two
    // synthetic documents above passed it comfortably; these three did not.
    const texts = await corpusAugmentedChunks();
    const lengths = await wordPieceLengths(texts);
    const longest = Math.max(...lengths);
    const over = lengths.filter((length) => length > SEQUENCE_LIMIT).length;

    console.info(
      `[budget] evals/dataset: ${texts.length} chunks | longest ${longest}/` +
        `${SEQUENCE_LIMIT} WordPiece | over limit ${over}`,
    );

    expect(over).toBe(0);
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
