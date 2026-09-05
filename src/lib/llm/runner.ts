import { streamText } from "ai";

import { languageModel } from "./models";
import type { ModelRunner } from "./types";

/**
 * THE MODEL RUNNER — the only place the AI SDK is called.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY IT ITERATES `fullStream` AND NOT `textStream`
 *
 * This is the detail that makes failover work, and it is not obvious from the
 * API's shape. In AI SDK 7 a provider error during streaming is NOT thrown from
 * the iterator. Verified against this exact version and provider: iterating
 * `fullStream` on a request that fails with a 401 yields
 *
 *     { type: 'start' }
 *     { type: 'error', error: APICallError }
 *
 * and then COMPLETES NORMALLY. A `for await` over `textStream` sees an empty
 * stream and finishes without incident.
 *
 * So the naive implementation — wrap `textStream` in try/catch and fail over on
 * a throw — never fails over, because nothing ever throws. A delisted model
 * would produce a cheerful empty answer, the pool would never be consulted, and
 * the symptom would be blank responses rather than an error anyone could chase.
 *
 * Hence: iterate `fullStream`, watch for the `error` part, and rethrow it so
 * the pool above can classify it and move to the next model.
 */

export function createModelRunner(): ModelRunner {
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let finishReason: string | null = null;

  return {
    async *stream({ modelId, system, prompt, signal }) {
      promptTokens = null;
      completionTokens = null;
      finishReason = null;

      const result = streamText({
        model: languageModel(modelId),
        system,
        prompt,
        abortSignal: signal,
        // Grounded extraction, not composition. Near-zero temperature keeps the
        // answer close to the passages and makes the eval harness measure the
        // retrieval rather than the sampler.
        temperature: 0,
      });

      let streamError: unknown = null;

      for await (const part of result.fullStream) {
        switch (part.type) {
          case "text-delta":
            // `.text` on the fullStream union, not `.delta` — the UI message
            // stream uses a different part shape with the same type name.
            yield part.text;
            break;
          case "error":
            // Captured rather than thrown from inside the loop, so the stream
            // is drained and the underlying response is not left dangling.
            streamError = part.error;
            break;
          default:
            break;
        }
      }

      if (streamError) throw streamError;

      // Only meaningful once the stream has finished. These promises resolve at
      // completion; awaiting them earlier would deadlock against the loop above.
      const usage = await result.usage;
      promptTokens = usage.inputTokens ?? null;
      completionTokens = usage.outputTokens ?? null;
      finishReason = await result.finishReason;
    },

    lastUsage() {
      return { promptTokens, completionTokens, finishReason };
    },
  };
}
