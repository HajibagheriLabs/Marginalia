import { env } from "@/lib/env";

import { EmbeddingError, type EmbeddingProvider } from "./types";

/**
 * THE OPENROUTER EMBEDDING PROVIDER.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * A CORRECTION, RECORDED SO IT IS NOT RE-DERIVED
 *
 * This file exists because an earlier claim in this codebase was WRONG. It said
 * OpenRouter has no embedding and no reranking models, citing a count of its
 * catalogue. The count was real; the conclusion was not.
 *
 * `GET /api/v1/models` returns only models whose output modality is text, image
 * or audio — 428 of them. Embedding and reranking models are in the catalogue
 * but are NOT in that default listing. They appear when the output modality is
 * asked for explicitly:
 *
 *     GET /api/v1/models?output_modalities=embeddings   -> 37 models
 *     GET /api/v1/models?output_modalities=rerank       ->  7 models
 *
 * So "I listed the catalogue and there were none" was a query that could not
 * have found them. Free variants exist in both lists. The lesson worth keeping
 * is narrow and practical: a filtered API listing is evidence about the filter
 * before it is evidence about the catalogue.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * IT IS AN OPTION, NOT THE DEFAULT
 *
 * `local` (bge-small-en-v1.5) remains the default and the shipped
 * configuration. This provider is here so the EmbeddingProvider interface has a
 * second real implementation behind it — an interface with one implementation
 * is a hypothesis — and so a deployment without the memory or the cold-start
 * budget for in-process inference has somewhere to go.
 *
 * What each costs, plainly:
 *
 *   local        no key, no network, no quota, ~34 MB of weights resident, a
 *                multi-second cold start, and CPU on the request path.
 *   openrouter   no weights, no cold start, an HTTP round trip per batch, an
 *                API key, and a shared free-tier quota that can refuse.
 *
 * The second one puts a network dependency in the middle of ingestion, which
 * is why it is not the default: a document half-embedded when a quota runs out
 * is a resumable state this pipeline handles, but it is still a worse day than
 * not having the dependency.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * `:free` IS ENFORCED, HERE AS EVERYWHERE
 *
 * env.ts refuses to boot when EMBEDDING_PROVIDER is `openrouter` and
 * EMBEDDING_MODEL does not end in `:free`. Ingestion embeds every chunk of
 * every document, so a metered embedder is the single easiest way to turn an
 * upload into a bill — a far larger exposure than the chat pool, which spends
 * one request per question.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * CHANGING THE MODEL MEANS A NEW COLLECTION, NOT A CONFIG EDIT
 *
 * These models do not share bge's 384 dimensions —
 * `nvidia/nemotron-3-embed-1b:free` returns 2048 — so switching providers
 * changes the vector width, which means a new Qdrant collection AND a
 * re-ingest of every document. `EMBEDDING_DIMENSIONS` and `QDRANT_COLLECTION`
 * both have to move with it. `assertSameEmbeddingSpace` is what stops the
 * half-migrated state from being silently searchable; see space.ts.
 */

/* ========================================================================== *
 * TUNING
 * ========================================================================== */

export const OPENROUTER_EMBEDDING = {
  endpoint: "https://openrouter.ai/api/v1/embeddings",

  /**
   * Texts per request.
   *
   * Bounds REQUEST SIZE rather than memory — the opposite constraint to the
   * local provider, where the batch bounds resident activations. A chunk is
   * ~260 tokens, so 64 of them is a request in the low hundreds of kilobytes,
   * comfortably inside any gateway's body limit while still amortising the
   * round trip over a useful amount of work.
   */
  batchSize: 64,

  /** Per-request ceiling. Generous: a cold upstream model can take seconds. */
  timeoutMs: 60_000,

  /**
   * Attempts per batch, and the backoff between them.
   *
   * Unlike the chat pool there is NO FAILOVER MODEL here, and there cannot be:
   * a second embedding model is a second embedding space, and quietly finishing
   * a document in a different space is exactly the corruption `space.ts` exists
   * to prevent. So a batch retries the SAME model or the stage fails, and the
   * ingestion state machine resumes it later.
   */
  maxAttempts: 3,
  retryBaseMs: 500,
} as const;

/** Retried: transient upstream conditions. Everything else fails immediately. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/* ========================================================================== *
 * WIRE FORMAT
 * ========================================================================== */

/**
 * The response shape, which is OpenAI's `/v1/embeddings` shape.
 *
 * `index` is echoed per item and is the reason this is parsed rather than
 * mapped positionally: the contract this provider has to keep is that
 * `result[i]` is the vector for `texts[i]`, and trusting array order to deliver
 * that is trusting an undocumented property of someone else's gateway. Sorting
 * by `index` costs nothing and makes the guarantee real.
 */
interface EmbeddingsResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
  error?: { message?: string; code?: number };
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

async function postBatch(
  model: string,
  texts: string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  const response = await fetch(OPENROUTER_EMBEDDING.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input: texts }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new HttpEmbeddingError(response.status, describeHttp(response.status, body));
  }

  const payload = (await response.json()) as EmbeddingsResponse;

  if (payload.error) {
    throw new EmbeddingError(
      `The embedding gateway returned an error: ${payload.error.message ?? "unknown"}`,
    );
  }

  const items = payload.data;
  if (!Array.isArray(items) || items.length !== texts.length) {
    throw new EmbeddingError(
      `The embedding gateway returned ${items?.length ?? 0} vectors for ` +
        `${texts.length} texts.`,
    );
  }

  // Ordered by the echoed index, never by arrival. See the interface note above.
  const ordered = [...items].sort(
    (a, b) => (a.index ?? 0) - (b.index ?? 0),
  );

  return ordered.map((item, position) => {
    if (!Array.isArray(item.embedding)) {
      throw new EmbeddingError(
        `The embedding gateway returned no vector for text ${position}.`,
      );
    }
    return item.embedding;
  });
}

/** Carries the status code so the retry loop can tell transient from fatal. */
class HttpEmbeddingError extends EmbeddingError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpEmbeddingError";
  }
}

/**
 * What went wrong, in words an operator can act on.
 *
 * The three that actually happen are told apart, because the fixes are
 * completely different: wait, edit a key, or edit a model id.
 */
function describeHttp(status: number, body: string): string {
  const detail = body.slice(0, 200);
  if (status === 401 || status === 403) {
    return `The embedding gateway rejected this app's credentials (${status}). Check OPENROUTER_API_KEY.`;
  }
  if (status === 404) {
    return (
      `The embedding model ${env.EMBEDDING_MODEL} was not found (404). Free models are ` +
      `delisted without notice — check https://openrouter.ai/api/v1/models?output_modalities=embeddings`
    );
  }
  if (status === 429) {
    return "The embedding gateway is rate-limited (429). Ingestion will resume from this stage.";
  }
  return `The embedding gateway returned ${status}. ${detail}`;
}

/* ========================================================================== *
 * VECTOR HYGIENE
 * ========================================================================== */

/**
 * L2-normalise, even though the measured provider already does.
 *
 * `nvidia/nemotron-3-embed-1b:free` returns vectors whose norm is 1.0 to six
 * decimal places, so this is a no-op against it today. It is here because the
 * EmbeddingProvider contract PROMISES normalised vectors and the vector store
 * relies on that promise — Qdrant is configured for cosine distance, and a
 * dot product only equals a cosine when both sides are unit length. There are
 * 37 embedding models behind this endpoint and nothing in the wire format says
 * which of them normalise. Re-normalising costs one pass over a 2048-float
 * array and removes the question entirely.
 */
function normalise(vector: number[]): number[] {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);

  if (!Number.isFinite(norm) || norm === 0) {
    throw new EmbeddingError(
      "The embedding gateway returned a zero or non-finite vector, which cannot be normalised.",
    );
  }

  // Already unit length to within float noise: return as-is rather than
  // rewriting every component for no reason.
  if (Math.abs(norm - 1) < 1e-6) return vector;
  return vector.map((value) => value / norm);
}

function assertUsableTexts(texts: string[]): void {
  const empty = texts.findIndex((text) => text.trim().length === 0);
  if (empty !== -1) {
    throw new EmbeddingError(
      `Cannot embed an empty string (index ${empty} of ${texts.length}).`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ========================================================================== *
 * THE PROVIDER
 * ========================================================================== */

export function createOpenRouterEmbeddingProvider(): EmbeddingProvider {
  const model = env.EMBEDDING_MODEL;
  const dimensions = env.EMBEDDING_DIMENSIONS;

  async function embedBatch(texts: string[]): Promise<number[][]> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= OPENROUTER_EMBEDDING.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        OPENROUTER_EMBEDDING.timeoutMs,
      );

      try {
        const vectors = await postBatch(model, texts, controller.signal);

        return vectors.map((vector) => {
          // The same guard the local provider applies, for the same reason: a
          // dimension mismatch means EMBEDDING_MODEL and EMBEDDING_DIMENSIONS
          // have drifted apart, and the alternative to catching it here is
          // Qdrant rejecting points one at a time, halfway through a document.
          if (vector.length !== dimensions) {
            throw new EmbeddingError(
              `${model} produced ${vector.length}-dimensional vectors but ` +
                `EMBEDDING_DIMENSIONS is ${dimensions}. These must match; ` +
                `changing the model means a new Qdrant collection and ` +
                `re-ingesting every document.`,
            );
          }
          return normalise(vector);
        });
      } catch (error) {
        lastError = error;

        const status = error instanceof HttpEmbeddingError ? error.status : 0;
        const transient =
          status === 0
            ? // A transport failure — DNS, socket reset, timeout. Not
              // attributable to the request, so worth another attempt.
              error instanceof Error && error.name !== "EmbeddingError"
            : RETRYABLE_STATUS.has(status);

        if (!transient || attempt === OPENROUTER_EMBEDDING.maxAttempts) break;

        // Linear backoff. The free tier's limiter is per-minute, so a long
        // exponential wait inside one invocation would spend the function's
        // time budget rather than the quota's recovery window; the ingestion
        // state machine is the real retry mechanism here.
        await sleep(OPENROUTER_EMBEDDING.retryBaseMs * attempt);
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError instanceof EmbeddingError
      ? lastError
      : new EmbeddingError(
          `The embedding gateway could not be reached. ${
            lastError instanceof Error ? lastError.message : String(lastError)
          }`,
          { cause: lastError },
        );
  }

  return {
    model,
    dimensions,

    async embedDocuments(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      assertUsableTexts(texts);

      const vectors: number[][] = [];
      for (let i = 0; i < texts.length; i += OPENROUTER_EMBEDDING.batchSize) {
        const batch = texts.slice(i, i + OPENROUTER_EMBEDDING.batchSize);
        vectors.push(...(await embedBatch(batch)));
      }
      return vectors;
    },

    /**
     * NO QUERY PREFIX, and that is a measurement rather than an omission.
     *
     * bge is asymmetric and needs "Represent this sentence for searching
     * relevant passages: " on the query side only — getting that wrong costs
     * recall silently, which is why the local provider makes a noise about it.
     *
     * The models behind this endpoint are used unprefixed, and it separates
     * cleanly: against `nvidia/nemotron-3-embed-1b:free`, the question "How
     * much notice is required to terminate the agreement?" scores cosine 0.682
     * against the clause that answers it and 0.085 against an unrelated expenses
     * clause from the same contract. A prefix invented for a model that was not
     * trained with one is noise added to the query, so none is added.
     *
     * If a model that DOES want an instruction prefix is configured here, the
     * prefix belongs in this method, keyed by model id — never at a call site.
     * The whole point of two methods on the interface is that the asymmetry is
     * the provider's business.
     */
    async embedQuery(text: string): Promise<number[]> {
      assertUsableTexts([text]);
      const [vector] = await embedBatch([text]);
      return vector;
    },
  };
}
