import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOpenRouterEmbeddingProvider } from "./openrouter";
import { EmbeddingError } from "./types";

/**
 * THE HOSTED EMBEDDER, against a scripted transport.
 *
 * `fetch` is mocked and nothing else is. The properties worth asserting here
 * are all properties of how this file handles a RESPONSE — order,
 * normalisation, dimension, retry — and none of them are about whether
 * OpenRouter is reachable. A test that made real calls would spend quota to
 * assert someone else's uptime, and would go red when their gateway did.
 *
 * The wire shapes below are copied from live responses, not invented:
 * `{ data: [{ embedding, index }], usage }`, vectors already unit length,
 * 2048 dimensions from `nvidia/nemotron-3-embed-1b:free`.
 */

const DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS ?? 384);

/** A unit vector of the configured width, so the dimension guard is satisfied. */
function unit(seed: number): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  vector[seed % DIMENSIONS] = 1;
  return vector;
}

/** An UNNORMALISED vector — length 2 along one axis. */
function doubled(seed: number): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  vector[seed % DIMENSIONS] = 2;
  return vector;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function embeddingsBody(vectors: number[][], order?: number[]) {
  return {
    object: "list",
    data: vectors.map((embedding, i) => ({
      object: "embedding",
      embedding,
      index: order ? order[i] : i,
    })),
    model: "nvidia/nemotron-3-embed-1b:free",
    usage: { prompt_tokens: 9, total_tokens: 9 },
  };
}

describe("OpenRouter embedding provider", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("posts to the embeddings endpoint with the configured model", async () => {
    fetchMock.mockResolvedValue(jsonResponse(embeddingsBody([unit(1), unit(2)])));

    const provider = createOpenRouterEmbeddingProvider();
    await provider.embedDocuments(["first passage", "second passage"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(init.method).toBe("POST");

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(provider.model);
    expect(body.input).toEqual(["first passage", "second passage"]);
  });

  /**
   * THE ONE THAT WOULD BE SILENT.
   *
   * The contract is `result[i]` is the vector for `texts[i]`, and the gateway
   * echoes an `index` per item precisely because arrival order is not promised.
   * Reading positionally would attach the wrong vector to every chunk — which
   * throws nothing, indexes fine, and simply makes retrieval wrong in a way no
   * assertion elsewhere in the codebase would catch.
   */
  it("reorders by the echoed index rather than trusting arrival order", async () => {
    // The gateway answers 1, 0 — reversed.
    fetchMock.mockResolvedValue(
      jsonResponse(embeddingsBody([unit(9), unit(4)], [1, 0])),
    );

    const provider = createOpenRouterEmbeddingProvider();
    const [first, second] = await provider.embedDocuments(["a", "b"]);

    // index 0 was the SECOND item in the payload.
    expect(first).toEqual(unit(4));
    expect(second).toEqual(unit(9));
  });

  it("L2-normalises whatever the gateway returns", async () => {
    fetchMock.mockResolvedValue(jsonResponse(embeddingsBody([doubled(3)])));

    const provider = createOpenRouterEmbeddingProvider();
    const [vector] = await provider.embedDocuments(["passage"]);

    const norm = Math.hypot(...vector);
    expect(norm).toBeCloseTo(1, 6);
  });

  it("refuses a vector of the wrong width instead of indexing it", async () => {
    // What a mismatched EMBEDDING_MODEL / EMBEDDING_DIMENSIONS pair looks like.
    fetchMock.mockResolvedValue(
      jsonResponse(embeddingsBody([[0.1, 0.2, 0.3]])),
    );

    const provider = createOpenRouterEmbeddingProvider();
    await expect(provider.embedDocuments(["passage"])).rejects.toThrow(
      /EMBEDDING_DIMENSIONS/,
    );
  });

  it("refuses a zero vector, which cannot be normalised", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(embeddingsBody([new Array<number>(DIMENSIONS).fill(0)])),
    );

    const provider = createOpenRouterEmbeddingProvider();
    await expect(provider.embedDocuments(["passage"])).rejects.toBeInstanceOf(
      EmbeddingError,
    );
  });

  it("refuses an empty string rather than embedding whitespace", async () => {
    const provider = createOpenRouterEmbeddingProvider();
    await expect(provider.embedDocuments(["fine", "   "])).rejects.toThrow(
      /empty string \(index 1 of 2\)/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns no vectors, and makes no call, for no texts", async () => {
    const provider = createOpenRouterEmbeddingProvider();
    expect(await provider.embedDocuments([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("failure handling", () => {
    it("retries a 429 and succeeds on a later attempt", async () => {
      fetchMock
        .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
        .mockResolvedValueOnce(jsonResponse(embeddingsBody([unit(1)])));

      const provider = createOpenRouterEmbeddingProvider();
      const [vector] = await provider.embedDocuments(["passage"]);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(vector).toEqual(unit(1));
    });

    /**
     * A 401 is a configuration error, and every retry repeats it. Retrying
     * would turn one clear failure into three slower identical ones and spend
     * the ingestion stage's time budget doing it.
     */
    it("does not retry a 401", async () => {
      fetchMock.mockResolvedValue(new Response("no", { status: 401 }));

      const provider = createOpenRouterEmbeddingProvider();
      await expect(provider.embedDocuments(["passage"])).rejects.toThrow(
        /OPENROUTER_API_KEY/,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("names the delisting when the model 404s", async () => {
      fetchMock.mockResolvedValue(new Response("gone", { status: 404 }));

      const provider = createOpenRouterEmbeddingProvider();
      await expect(provider.embedDocuments(["passage"])).rejects.toThrow(
        /delisted without notice/,
      );
      // A 404 is not transient either: the model is gone until config changes.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    /**
     * NO FAILOVER MODEL, and that is deliberate rather than missing.
     *
     * The chat pool fails over to another free model on a 429. An embedder
     * cannot: a second model is a second embedding space, and finishing a
     * document in a different space is exactly the corruption space.ts exists
     * to prevent. So the batch gives up and the ingestion state machine
     * resumes the stage later.
     */
    it("gives up on the same model rather than trying another", async () => {
      fetchMock.mockResolvedValue(new Response("busy", { status: 503 }));

      const provider = createOpenRouterEmbeddingProvider();
      await expect(provider.embedDocuments(["passage"])).rejects.toThrow();

      // Three attempts, all at the configured model, and no other slug tried.
      expect(fetchMock).toHaveBeenCalledTimes(3);
      const models = fetchMock.mock.calls.map(
        ([, init]) => JSON.parse(init.body as string).model,
      );
      expect(new Set(models).size).toBe(1);
    });

    it("refuses a short payload rather than zipping it against the wrong chunks", async () => {
      fetchMock.mockResolvedValue(jsonResponse(embeddingsBody([unit(1)])));

      const provider = createOpenRouterEmbeddingProvider();
      await expect(
        provider.embedDocuments(["one", "two", "three"]),
      ).rejects.toThrow(/1 vectors for 3 texts/);
    });
  });
});
