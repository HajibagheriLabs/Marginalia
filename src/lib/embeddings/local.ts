import type { FeatureExtractionPipeline } from "@huggingface/transformers";

import { env } from "@/lib/env";

import { EmbeddingError, type EmbeddingProvider } from "./types";

/**
 * THE LOCAL EMBEDDING PROVIDER — Transformers.js, in this Node process.
 *
 * No HTTP call, no API key, no vendor, no per-token cost, and nothing to
 * rate-limit. The model weights are downloaded once from the Hugging Face CDN,
 * cached on disk, and then run through ONNX Runtime on the CPU of whatever
 * machine this process happens to be.
 *
 * That is a deliberate architectural choice and not a placeholder. A portfolio
 * project that needs a credit card on file to demonstrate retrieval is a
 * project nobody can run. The cost of the choice is real and is paid in three
 * places, all of which the code below is shaped around:
 *
 *   1. COLD START. The first embed after a fresh process pays for the model
 *      load — see the singleton. Every subsequent call is single-digit
 *      milliseconds.
 *   2. RUNTIME. Inference must run on the Node runtime, never the Edge
 *      runtime, and it is CPU-bound rather than IO-bound, which inverts the
 *      usual concurrency advice — see the serialisation queue.
 *   3. MEMORY. Weights plus activations live in the function's memory budget.
 *      Hence a bounded batch size rather than one giant call.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * BGE IS ASYMMETRIC. THIS IS THE PART THAT BREAKS SILENTLY.
 *
 * bge-small-en-v1.5 was trained with an instruction prefix on the QUERY side
 * only. A question must be embedded as
 *
 *     "Represent this sentence for searching relevant passages: <question>"
 *
 * and a passage must be embedded with NO prefix at all. The two methods on
 * this provider exist to make that asymmetry impossible to get wrong at a call
 * site, because getting it wrong does not throw, does not log, and does not
 * look like anything: prefixing both sides, or neither, still returns
 * 384 unit-length floats and still returns ranked results. It just returns
 * measurably worse ones, and the only way to notice is an eval set.
 * ───────────────────────────────────────────────────────────────────────────
 */

/* ========================================================================== *
 * TUNING
 * ========================================================================== */

export const LOCAL_EMBEDDING = {
  /**
   * The instruction prefix BGE expects on queries and only on queries.
   * The trailing space is part of it — do not trim this string.
   */
  queryPrefix: "Represent this sentence for searching relevant passages: ",

  /**
   * Texts per forward pass.
   *
   * Bounds PEAK MEMORY, which is the actual constraint here. Every text in a
   * batch is padded to the longest in that batch and held as activations at
   * once, so a batch of 512 chunks is not 16x faster than a batch of 32 — it is
   * roughly the same speed with 16x the resident memory, on a function that is
   * billed for and limited by exactly that. 32 is comfortably inside a Hobby
   * function's budget for 512-token sequences.
   */
  batchSize: 32,

  /**
   * Quantised ONNX weights (int8). ~34 MB against ~130 MB for fp32.
   *
   * The accuracy cost on a retrieval task is small and the download,
   * cold-start, and memory savings are not. This is the file that makes the
   * whole local-inference approach viable on a free tier.
   *
   * One measured consequence, worth knowing before it surprises someone: int8
   * inference is very slightly BATCH-SHAPE DEPENDENT. The same text embedded
   * inside a 69-item batch and inside a 3-item batch agrees to a cosine of
   * about 0.997, not 1.0. That is far below anything that changes a ranking,
   * but it does mean vectors are not bit-reproducible across batch sizes — so
   * do not build a cache key, a checksum, or an equality assertion on one.
   */
  dtype: "q8",

  /** Where weights are cached when nothing else is configured. See below. */
  serverlessCacheDir: "/tmp/transformers-cache",
} as const;

/* ========================================================================== *
 * THE SINGLETON
 * ========================================================================== */

/**
 * The loaded pipeline, as a PROMISE rather than a value.
 *
 * A promise, not a value, because the load is async and two concurrent
 * requests arriving at a cold process must not both start one. Caching the
 * promise means the second caller awaits the first caller's load; caching a
 * value would need a lock to achieve the same thing.
 *
 * Module-level, because constructing this per call re-reads and re-parses tens
 * of megabytes of weights and turns a ~20 ms embed into a multi-second one.
 * That single mistake is the difference between local inference being viable
 * and being unusable, which is why it is called out in the project brief.
 */
let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

/**
 * Where the weights live on disk.
 *
 * Transformers.js defaults to a directory inside `node_modules`, which is
 * READ-ONLY on Vercel — the load fails there with an unhelpful filesystem
 * error. `/tmp` is the only writable path in a Vercel function, and it
 * survives for the life of the instance, so a warm instance reuses the
 * download instead of fetching 34 MB again on every invocation.
 *
 * Configurable so that a container deployment can point it at a real volume
 * baked at image-build time and never download at runtime at all.
 */
function cacheDirectory(): string | undefined {
  if (env.TRANSFORMERS_CACHE_DIR) return env.TRANSFORMERS_CACHE_DIR;
  if (process.env.VERCEL) return LOCAL_EMBEDDING.serverlessCacheDir;
  // Local development: the library default inside node_modules is writable and
  // survives across dev-server restarts, which is what you want there.
  return undefined;
}

async function loadPipeline(): Promise<FeatureExtractionPipeline> {
  /*
   * IMPORTED HERE, NOT AT MODULE SCOPE. This is a deployment property, not a
   * style preference.
   *
   * `@huggingface/transformers`'s Node build statically imports `sharp`, which
   * is a native library, and it pulls in `onnxruntime-node`, which resolves
   * prebuilt `.node` binaries by path. A STATIC import at the top of this file
   * therefore makes loading a native stack a precondition for merely importing
   * the module — and every route that transitively imports it inherits that.
   *
   * When one of those bindings cannot load, a static import fails during module
   * evaluation, before any handler runs. Next.js answers that with a BLANK 500:
   * no body, no message, and the same response for a malformed request as for a
   * valid one. That is exactly what happened on the first deployment of this
   * app — /api/chat and /api/ingest 500'd on every request while every route
   * that did not touch this stack was fine, and nothing in the response said
   * why.
   *
   * Deferring the import to here moves the failure to the first CALL, where
   * `getPipeline` already turns it into an `EmbeddingError` carrying a sentence
   * a person can read, the ingestion state machine records it against the
   * document, and the retrieval layer can fall back. The singleton is
   * unaffected — this function still runs exactly once per process.
   */
  const { env: transformersEnv, pipeline } = await import(
    "@huggingface/transformers"
  );

  const directory = cacheDirectory();
  if (directory) transformersEnv.cacheDir = directory;

  // Skip the "is there a copy in node_modules/@huggingface/transformers/models"
  // probe. Nothing ever puts one there, and on a read-only filesystem the
  // failed lookup is noise in the logs before the remote fetch that follows.
  transformersEnv.allowLocalModels = false;

  const started = Date.now();
  const extractor = await pipeline("feature-extraction", env.EMBEDDING_MODEL, {
    dtype: LOCAL_EMBEDDING.dtype,
  });

  // The one-time cost, logged once. On a cold instance this is dominated by
  // the 34 MB download; on a warm one it is the ONNX session build only.
  console.info(
    `[embeddings] loaded ${env.EMBEDDING_MODEL} (${LOCAL_EMBEDDING.dtype}, ` +
      `${env.EMBEDDING_DIMENSIONS}d) in ${Date.now() - started}ms` +
      `${directory ? ` from cache ${directory}` : ""}`,
  );

  return extractor;
}

function getPipeline(): Promise<FeatureExtractionPipeline> {
  pipelinePromise ??= loadPipeline().catch((error: unknown) => {
    // Do not cache a rejection forever. A cold start that fails because the
    // CDN blipped must be retryable by the next request, and the ingestion
    // state machine's "Retry" action depends on that being true.
    pipelinePromise = null;
    throw new EmbeddingError(
      `The embedding model could not be loaded. ${describeLoadFailure(error)}`,
      { cause: error },
    );
  });
  return pipelinePromise;
}

function describeLoadFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/EACCES|EROFS|permission denied/i.test(message)) {
    return "The weights cache directory is not writable — set TRANSFORMERS_CACHE_DIR to a writable path.";
  }
  if (/fetch|ENOTFOUND|ECONNRESET|network/i.test(message)) {
    return "The weights could not be downloaded from the model host. Check outbound network access and try again.";
  }
  return message;
}

/* ========================================================================== *
 * CONCURRENCY
 * ========================================================================== */

/**
 * Every inference in this process runs one at a time.
 *
 * This inverts the usual advice, deliberately. Concurrency helps when work is
 * IO-bound: ten HTTP calls in flight finish in the time of the slowest. This
 * work is CPU-bound, and ONNX Runtime ALREADY parallelises a single forward
 * pass across threads. Running two batches at once does not use more CPU than
 * there is — it just holds two sets of activations in memory simultaneously
 * and makes both finish later.
 *
 * The concrete failure it prevents: two documents finishing extraction at the
 * same moment, both entering the embedding stage, and the function being
 * killed for exceeding its memory limit — which surfaces as an opaque
 * platform error with no stack, on one of the two documents, at random.
 *
 * There are no 429s here and nothing to back off from. A queue, not a retry.
 */
let queue: Promise<unknown> = Promise.resolve();

function serialise<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  // Keep the chain alive after a failure: one document failing to embed must
  // not poison the queue for every document behind it.
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Hand the event loop back between batches.
 *
 * A long synchronous-ish run of forward passes would otherwise stall timers,
 * health checks, and the streaming response of any request sharing this
 * process. `setImmediate` yields after the current macrotask, which is enough
 * for the loop to drain.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/* ========================================================================== *
 * THE PROVIDER
 * ========================================================================== */

/**
 * THE TRUNCATION ALARM.
 *
 * bge-small-en-v1.5 accepts 512 WordPiece tokens. Longer input is cut to fit by
 * the tokenizer, and that is the single most dangerous thing that can happen in
 * this file, because of what it does NOT do: it does not throw, it does not
 * warn, it does not return a shorter vector, and it does not mark the result in
 * any way. The tail of the passage simply stops contributing to its embedding
 * while the stored text still displays it. The passage becomes unfindable by
 * the words at its end, retrieval quietly gets worse, and there is nothing
 * anywhere to point at.
 *
 * The chunker's budget is set to keep this from happening — but that budget is
 * denominated in cl100k tokens and this limit is in WordPiece tokens, so the
 * two are related by an empirical ratio (measured at ~1.19 for English legal
 * prose) rather than by an identity. An unusually dense passage, a table, or a
 * non-English document can cross the line even when the cl100k count says it
 * should not.
 *
 * So the invariant is checked here, where the real tokenizer is, rather than
 * assumed upstream. Warn rather than throw: a passage a few tokens over is
 * still a mostly-good vector, and failing the whole ingestion would be a worse
 * outcome than an imperfect one. The point is that it can no longer be silent.
 *
 * Costs one tokenization pass per batch, which is microseconds against a
 * forward pass measured in milliseconds.
 */
function warnOnTruncation(
  extractor: FeatureExtractionPipeline,
  batch: string[],
): void {
  const tokenizer = extractor.tokenizer;
  const limit = tokenizer.model_max_length;
  if (!limit) return;

  let worst = 0;
  let over = 0;

  for (const text of batch) {
    const encoded = tokenizer(text, { truncation: false, padding: false });
    const length = encoded.input_ids.dims.at(-1) as number;
    if (length > limit) {
      over += 1;
      worst = Math.max(worst, length);
    }
  }

  if (over > 0) {
    console.warn(
      `[embeddings] TRUNCATION: ${over} of ${batch.length} texts exceed ` +
        `${env.EMBEDDING_MODEL}'s ${limit}-token limit (longest ${worst}). ` +
        `The tail of each is dropped from its vector but kept in the stored ` +
        `text, so those passages will under-retrieve. Lower CHUNKING.maxTokens ` +
        `in src/lib/ingest/chunk.ts and re-ingest.`,
    );
  }
}

function assertUsableTexts(texts: string[]): void {
  const empty = texts.findIndex((text) => text.trim().length === 0);
  if (empty !== -1) {
    // A blank string still produces a unit vector, and that vector is
    // meaningless — it would sit in the index matching everything weakly.
    // Whatever produced it upstream is the bug; fail where it is visible.
    throw new EmbeddingError(
      `Cannot embed an empty string (index ${empty} of ${texts.length}).`,
    );
  }
}

/**
 * Run one batch and return plain arrays.
 *
 * `pooling: "mean"` averages the token vectors into one sentence vector, and
 * `normalize: true` L2-normalises the result — both required by the interface
 * contract, and both cheap enough that doing them here rather than by hand is
 * strictly better.
 */
async function runBatch(
  extractor: FeatureExtractionPipeline,
  batch: string[],
  dimensions: number,
): Promise<number[][]> {
  warnOnTruncation(extractor, batch);

  const tensor = await extractor(batch, { pooling: "mean", normalize: true });
  const vectors = tensor.tolist() as number[][];

  if (vectors.length !== batch.length) {
    throw new EmbeddingError(
      `The model returned ${vectors.length} vectors for ${batch.length} texts.`,
    );
  }

  // Guard the configured dimension against the model's actual output. These
  // disagree exactly when EMBEDDING_MODEL and EMBEDDING_DIMENSIONS have drifted
  // apart in the environment, and the consequence of not catching it here is a
  // collection full of vectors of the wrong width — which Qdrant rejects late,
  // per point, halfway through indexing a document.
  for (const vector of vectors) {
    if (vector.length !== dimensions) {
      throw new EmbeddingError(
        `${env.EMBEDDING_MODEL} produced ${vector.length}-dimensional vectors ` +
          `but EMBEDDING_DIMENSIONS is ${dimensions}. These must match; ` +
          `changing the model means re-ingesting every document.`,
      );
    }
  }

  return vectors;
}

/**
 * Build the local provider.
 *
 * Stateless in itself — all the state that matters is the module-level
 * pipeline promise and queue, which are shared across every instance on
 * purpose. Calling this twice does not load the model twice.
 */
export function createLocalEmbeddingProvider(): EmbeddingProvider {
  const model = env.EMBEDDING_MODEL;
  const dimensions = env.EMBEDDING_DIMENSIONS;

  return {
    model,
    dimensions,

    async embedDocuments(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      assertUsableTexts(texts);

      return serialise(async () => {
        const extractor = await getPipeline();
        const vectors: number[][] = [];

        for (let i = 0; i < texts.length; i += LOCAL_EMBEDDING.batchSize) {
          const batch = texts.slice(i, i + LOCAL_EMBEDDING.batchSize);
          vectors.push(...(await runBatch(extractor, batch, dimensions)));

          if (i + LOCAL_EMBEDDING.batchSize < texts.length) {
            await yieldToEventLoop();
          }
        }

        return vectors;
      });
    },

    async embedQuery(text: string): Promise<number[]> {
      assertUsableTexts([text]);

      return serialise(async () => {
        const extractor = await getPipeline();
        // THE PREFIX. Queries only — see the header comment. A passage that
        // accidentally receives this prefix, or a query that does not, costs
        // recall with nothing visible to debug.
        const prefixed = `${LOCAL_EMBEDDING.queryPrefix}${text}`;
        const [vector] = await runBatch(extractor, [prefixed], dimensions);
        return vector;
      });
    },
  };
}

/**
 * Drop the cached pipeline. Tests only.
 *
 * Exists so a test can assert the load happens once without leaking a warm
 * model into the next file's process.
 */
export function resetLocalEmbeddingProviderForTests(): void {
  pipelinePromise = null;
  queue = Promise.resolve();
}
