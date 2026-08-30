import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  env as transformersEnv,
  type PreTrainedModel,
  type PreTrainedTokenizer,
} from "@huggingface/transformers";

import { env } from "@/lib/env";

import type { Reranker } from "./types";

/**
 * RERANKING — a local cross-encoder, off by default.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT A CROSS-ENCODER IS, AND WHY IT IS A SECOND STAGE
 *
 * The embedding model is a BI-encoder: it maps the query to a vector and each
 * passage to a vector, separately, and compares them with a cosine. Separately
 * is what makes an index possible — passages are embedded once at ingest time
 * and searched millions of times — but it is also the limitation. The passage
 * vector was computed without ever seeing the question, so it has to be a
 * general-purpose summary of the passage rather than an answer to anything.
 *
 * A CROSS-encoder reads the query and the passage TOGETHER, in one forward
 * pass, with attention running between them. It can notice that "thirty days"
 * in the passage is the answer to "how much notice" in the query — a relation
 * neither vector could encode alone. It is markedly more accurate.
 *
 * It is also unusable as a search index, for the same reason it is accurate:
 * nothing can be precomputed. Ranking a corpus would mean one transformer pass
 * per passage per query. So it runs second, over the ~20 candidates the cheap
 * channels already agreed were plausible. Retrieval finds; reranking sorts.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS DOES NOT USE THE `text-classification` PIPELINE
 *
 * It looks like it should, and it silently does not work. Verified against
 * this model: `pipeline("text-classification")` returns a score of exactly
 * 1.0 for every pair, regardless of relevance.
 *
 * The reason is that ms-marco-MiniLM is a REGRESSION cross-encoder with a
 * single output logit, not a classifier. The classification pipeline applies
 * softmax across the label dimension — and softmax over one value is 1.0, for
 * every input. The ranking signal is not weak or noisy; it is mathematically
 * erased, and every passage ties.
 *
 * So the model and tokenizer are driven directly and the RAW LOGIT is read.
 * On a real example the raw scores separate cleanly: +6.9 for the passage that
 * answers the question, -11.0 for an irrelevant one from the same document.
 * That is the number this file returns, unsquashed — no sigmoid, because a
 * monotonic transform changes nothing about the ordering and would only hide
 * the scale from the trace table.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * OFF IS THE DEFAULT
 *
 * The whole application works with reranking off, and that is the shipped
 * configuration. It is a real cost — a second model in memory, a second cold
 * start, and a forward pass per candidate on the request path — and whether it
 * is worth paying is a question about this corpus that only the eval harness
 * can answer. `RETRIEVAL_RERANKER=local` turns it on so both can be measured.
 */

export const RERANK = {
  /**
   * How many fused candidates get scored.
   *
   * Small on purpose. A cross-encoder pass is roughly a thousand times the
   * work of a dot product, and it is on the request path where the user is
   * waiting. 20 is the point where the marginal candidate is unlikely to be
   * promoted into a top-8 that RRF already agrees on — reranking fixes the
   * ORDER of plausible results, it does not rescue a passage neither channel
   * ranked.
   */
  candidates: 20,

  /**
   * Pairs per forward pass. Every pair in a batch is padded to the longest, so
   * this bounds peak memory the same way the embedding batch size does.
   */
  batchSize: 8,

  /** Quantised weights, for the same reasons as the embedding model. */
  dtype: "q8",
} as const;

interface LoadedCrossEncoder {
  tokenizer: PreTrainedTokenizer;
  model: PreTrainedModel;
}

/**
 * Loaded once, lazily, at module scope — same reasoning as the embedding
 * pipeline. A rejected load is not cached, so a failed cold start is
 * retryable rather than permanent.
 */
let crossEncoderPromise: Promise<LoadedCrossEncoder> | null = null;

function loadCrossEncoder(): Promise<LoadedCrossEncoder> {
  crossEncoderPromise ??= (async () => {
    if (env.TRANSFORMERS_CACHE_DIR) {
      transformersEnv.cacheDir = env.TRANSFORMERS_CACHE_DIR;
    } else if (process.env.VERCEL) {
      transformersEnv.cacheDir = "/tmp/transformers-cache";
    }
    transformersEnv.allowLocalModels = false;

    const id = env.RETRIEVAL_RERANK_MODEL;
    const started = Date.now();
    const [tokenizer, model] = await Promise.all([
      AutoTokenizer.from_pretrained(id),
      AutoModelForSequenceClassification.from_pretrained(id, {
        dtype: RERANK.dtype,
      }),
    ]);
    console.info(
      `[rerank] loaded ${id} (${RERANK.dtype}) in ${Date.now() - started}ms`,
    );
    return { tokenizer, model };
  })().catch((error: unknown) => {
    crossEncoderPromise = null;
    throw error;
  });

  return crossEncoderPromise;
}

/**
 * The local cross-encoder.
 *
 * Scores are raw logits: unbounded, roughly centred on 0, and meaningful only
 * relative to each other within one query. They are NOT probabilities and are
 * not comparable across models — which is why the trace column is labelled
 * with the model name.
 */
export function createLocalReranker(): Reranker {
  return {
    model: env.RETRIEVAL_RERANK_MODEL,

    async score(query: string, passages: string[]): Promise<number[]> {
      if (passages.length === 0) return [];

      const { tokenizer, model } = await loadCrossEncoder();
      const scores: number[] = [];

      for (let i = 0; i < passages.length; i += RERANK.batchSize) {
        const batch = passages.slice(i, i + RERANK.batchSize);

        // The query is repeated once per passage: a cross-encoder input is the
        // PAIR, and there is no way to share the query's computation across
        // passages. That repetition is the cost being bought.
        const inputs = tokenizer(
          batch.map(() => query),
          { text_pair: batch, padding: true, truncation: true },
        );

        const output = await model(inputs);
        // [batch, 1] — one logit per pair. Reading [0] rather than taking an
        // argmax is the whole point; see the header.
        const logits = output.logits.tolist() as number[][];
        for (const row of logits) scores.push(row[0]);
      }

      return scores;
    },
  };
}

/**
 * The configured reranker, or null when reranking is off.
 *
 * Null rather than a no-op implementation, deliberately: the retrieval pipeline
 * has to know whether reranking happened, because the trace shows a rerank
 * column and the assembly step applies a different relevance floor when it did.
 * A no-op object that returned zeros would make "off" indistinguishable from
 * "on, and everything scored zero".
 */
export function getReranker(): Reranker | null {
  return env.RETRIEVAL_RERANKER === "local" ? createLocalReranker() : null;
}
