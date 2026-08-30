import { beforeAll, describe, expect, it } from "vitest";

import { LOCAL_EMBEDDING, createLocalEmbeddingProvider } from "./local";
import { EmbeddingError, type EmbeddingProvider } from "./types";

/**
 * The local embedding provider, against the real model.
 *
 * Runs actual inference rather than mocking it, because every property worth
 * asserting here is a property of the model's behaviour: that vectors come back
 * unit-length, that the dimension matches the configuration, and above all that
 * the BGE query prefix is applied to queries and only to queries. A mock would
 * assert that this file calls the functions this file calls.
 *
 * The first run downloads ~34 MB of quantised ONNX weights and is slow; every
 * run afterwards reads them from the on-disk cache. Set SKIP_MODEL_TESTS=1 to
 * skip on a machine with no network.
 */

const skip = process.env.SKIP_MODEL_TESTS === "1";

/** Vectors are L2-normalised, so the dot product IS the cosine similarity. */
function cosine(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

function norm(vector: number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

describe.skipIf(skip)("local embedding provider", () => {
  let provider: EmbeddingProvider;

  beforeAll(async () => {
    provider = createLocalEmbeddingProvider();
    // Pay the model load here rather than inside the first assertion, so a slow
    // cold start reads as a slow setup and not as a failing test.
    await provider.embedQuery("warm up the pipeline");
  }, 300_000);

  it("reports the configured model and dimension", () => {
    expect(provider.model).toBe(
      process.env.EMBEDDING_MODEL ?? "Xenova/bge-small-en-v1.5",
    );
    expect(provider.dimensions).toBe(
      Number(process.env.EMBEDDING_DIMENSIONS ?? 384),
    );
  });

  it("returns unit-length vectors of the right width", async () => {
    const vectors = await provider.embedDocuments([
      "The Provider may terminate this agreement on thirty days written notice.",
      "Invoices are payable within forty-five days of receipt.",
    ]);

    expect(vectors).toHaveLength(2);
    for (const vector of vectors) {
      expect(vector).toHaveLength(provider.dimensions);
      // The store uses cosine distance and assumes normalised input.
      expect(norm(vector)).toBeCloseTo(1, 5);
      expect(vector.every((value) => Number.isFinite(value))).toBe(true);
    }
  });

  /* ======================================================================== *
   * THE ASYMMETRY
   *
   * The bug these two tests exist for does not throw, does not log, and does
   * not change the shape of anything. Prefixing both sides — or neither —
   * still yields 384 unit-length floats and still returns ranked results, just
   * measurably worse ones. So it is pinned directly.
   * ======================================================================== */

  it("embeds a query differently from the same text as a passage", async () => {
    const text = "How much notice is required to terminate the agreement?";

    const asQuery = await provider.embedQuery(text);
    const [asPassage] = await provider.embedDocuments([text]);

    // Same input, two methods, two different vectors. If these were equal the
    // prefix would not be being applied at all.
    expect(cosine(asQuery, asPassage)).toBeLessThan(0.999);
  });

  it("applies exactly the documented BGE prefix, and only to queries", async () => {
    const text = "How much notice is required to terminate the agreement?";

    const asQuery = await provider.embedQuery(text);
    // Hand-prefixing a PASSAGE must reproduce the query embedding exactly. That
    // pins down what the asymmetry is, not merely that one exists: it proves
    // embedQuery adds this precise string and embedDocuments adds nothing.
    const [manuallyPrefixed] = await provider.embedDocuments([
      `${LOCAL_EMBEDDING.queryPrefix}${text}`,
    ]);

    expect(cosine(asQuery, manuallyPrefixed)).toBeGreaterThan(0.9999);
  });

  it("retrieves the relevant passage over an irrelevant one", async () => {
    // The end-to-end claim the whole module exists to support.
    const [termination, payment] = await provider.embedDocuments([
      "Either party may terminate this agreement for convenience by giving " +
        "thirty (30) days prior written notice to the other party.",
      "The Customer shall reimburse reasonable travel expenses incurred by " +
        "the Provider's personnel, supported by receipts.",
    ]);

    const query = await provider.embedQuery(
      "How much notice do I need to give to end the contract?",
    );

    expect(cosine(query, termination)).toBeGreaterThan(cosine(query, payment));
  });

  /* ======================================================================== *
   * BATCHING
   * ======================================================================== */

  it("preserves order across batch boundaries", async () => {
    // Deliberately more than one batch, so a bug in the slicing shows up as a
    // mismatch rather than being invisible on a short input.
    const count = LOCAL_EMBEDDING.batchSize * 2 + 5;
    const texts = Array.from(
      { length: count },
      (_, i) => `Clause ${i + 1} concerns the delivery of item number ${i + 1}.`,
    );

    const vectors = await provider.embedDocuments(texts);
    expect(vectors).toHaveLength(count);

    // Re-embed three texts spanning different batches on their own; each must
    // be nearest to the vector at its original index.
    //
    // Asserted as an ARGMAX rather than as near-equality on purpose. The int8
    // weights make a vector very slightly dependent on the shape of the batch
    // it was computed in — the same text in a 69-item batch and in a 3-item
    // batch agrees to about 0.997, not to 1.0. That is quantisation noise, far
    // below anything that affects ranking, but it means bit-exact
    // reproducibility across batch sizes is not a property this provider has.
    // Nearest-neighbour identity is the property that actually matters, and it
    // is also the one a slicing bug would break.
    const probeIndexes = [0, LOCAL_EMBEDDING.batchSize + 3, count - 1];
    const probes = await provider.embedDocuments(
      probeIndexes.map((index) => texts[index]),
    );

    probeIndexes.forEach((index, probe) => {
      const scores = vectors.map((vector) => cosine(vector, probes[probe]));
      const nearest = scores.indexOf(Math.max(...scores));

      expect(nearest).toBe(index);
      expect(scores[index]).toBeGreaterThan(0.99);
    });
  });

  it("returns nothing for no input", async () => {
    await expect(provider.embedDocuments([])).resolves.toEqual([]);
  });

  it("refuses to embed empty text", async () => {
    // A blank string yields a unit vector that means nothing and would match
    // everything weakly. Fail where the bug is, not in the ranking.
    await expect(provider.embedDocuments(["fine", "   "])).rejects.toThrow(
      EmbeddingError,
    );
    await expect(provider.embedQuery("")).rejects.toThrow(EmbeddingError);
  });

  it("serialises concurrent calls without corrupting results", async () => {
    // Two callers arriving at once must not interleave into each other's
    // tensors. Same text, concurrent, must give the same vector.
    const text = "Confidential information must be returned on termination.";
    const [a, b] = await Promise.all([
      provider.embedQuery(text),
      provider.embedQuery(text),
    ]);

    expect(cosine(a, b)).toBeGreaterThan(0.9999);
  });
});
