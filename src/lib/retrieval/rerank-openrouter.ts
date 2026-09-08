import { env } from "@/lib/env";

import type { Reranker } from "./types";

/**
 * THE OPENROUTER RERANKER.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS (see also src/lib/embeddings/openrouter.ts)
 *
 * An earlier claim in this codebase said OpenRouter has no reranking models.
 * It was wrong: `GET /api/v1/models` lists only text/image/audio output
 * modalities, and rerankers are found with
 * `GET /api/v1/models?output_modalities=rerank` — seven of them, one free.
 *
 * `local` remains the default. This is the second implementation behind the
 * `Reranker` interface, and it trades a resident cross-encoder and ~2 s of
 * in-process CPU for an HTTP round trip and a shared quota.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE SCORE SCALE IS DIFFERENT, AND THAT IS THE DANGEROUS PART
 *
 * The local cross-encoder returns RAW LOGITS: unbounded, centred near zero,
 * with 0 as the trained relevant/irrelevant boundary. `ASSEMBLY.minRerankScore`
 * was 0 for exactly that reason.
 *
 * This endpoint returns a PROBABILITY in (0, 1). Every score it can ever
 * produce is greater than zero, so a floor of 0 admits EVERYTHING — the
 * relevance floor stops existing, silently, and the system loses its ability to
 * say "nothing here answers that". Nothing throws; answers simply start being
 * grounded in the least-bad passage available.
 *
 * That is why `scoreFloor` is part of the `Reranker` interface rather than a
 * constant in assemble.ts. A reranker's floor is a property of its score scale,
 * so it travels with the implementation that defines that scale.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHERE 0.02 COMES FROM
 *
 * Measured against `nvidia/llama-nemotron-rerank-vl-1b-v2:free`, using the
 * question "What does the contractor get paid if the Government terminates the
 * contract for its own convenience?" over six passages from the committed eval
 * corpus:
 *
 *     0.998    the clause that answers it            (FAR 52.212-4 (l))
 *     0.205    a related termination clause          (FAR 52.212-4 (m))
 *     0.0023   an unrelated clause, same document    (risk of loss)
 *     0.0015   an unrelated clause, same document    (taxes)
 *     0.00012  a passage from a different document   (CDC guideline)
 *     0.00007  a passage from a different document   (NIST SP 800-63B)
 *
 * There are two orders of magnitude of empty space between 0.0023 and 0.205,
 * and 0.02 sits in the middle of it. It keeps genuinely related context and
 * drops everything the model scored as unrelated.
 *
 * It is deliberately NOT 0.5, which is the exact algebraic image of the local
 * floor: sigmoid(0) = 0.5, so "logit above zero" and "probability above a half"
 * are the same boundary. 0.5 would have dropped the 0.205 passage, and the
 * expensive failure in this application is refusing a question the documents
 * do answer — not including one passage more than strictly needed. Erring
 * toward recall here is the same judgement the RRF floor makes.
 *
 * Re-measure this if the model changes. A floor is a claim about a score
 * distribution, and a different model has a different one.
 */

export const OPENROUTER_RERANK = {
  endpoint: "https://openrouter.ai/api/v1/rerank",

  /**
   * The relevance floor for a (0, 1) probability score. See the header for the
   * measured distribution this sits in.
   */
  scoreFloor: 0.02,

  /** Per-request ceiling. One request scores the whole candidate window. */
  timeoutMs: 30_000,
} as const;

/**
 * The response shape, which is Cohere's `/rerank` shape.
 *
 * `results` comes back SORTED BY RELEVANCE, not by input order, and it is not
 * required to be complete. Both facts are load-bearing below.
 */
interface RerankResponse {
  results?: Array<{ index?: number; relevance_score?: number }>;
  error?: { message?: string };
}

export function createOpenRouterReranker(): Reranker {
  return {
    model: env.RETRIEVAL_RERANK_MODEL,
    scoreFloor: OPENROUTER_RERANK.scoreFloor,

    async score(query: string, passages: string[]): Promise<number[]> {
      if (passages.length === 0) return [];

      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        OPENROUTER_RERANK.timeoutMs,
      );

      try {
        const response = await fetch(OPENROUTER_RERANK.endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: env.RETRIEVAL_RERANK_MODEL,
            query,
            documents: passages,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(
            `rerank gateway returned ${response.status}: ${body.slice(0, 200)}`,
          );
        }

        const payload = (await response.json()) as RerankResponse;
        if (payload.error) {
          throw new Error(`rerank gateway error: ${payload.error.message ?? "unknown"}`);
        }

        const results = payload.results;
        if (!Array.isArray(results)) {
          throw new Error("rerank gateway returned no results array");
        }

        /*
         * SCATTER BACK INTO INPUT ORDER.
         *
         * The interface contract is "one score per passage, in the order
         * given", and this endpoint answers in DESCENDING RELEVANCE order —
         * verified: for a six-document request the indices came back
         * 0, 1, 3, 2, 4, 5. Reading `results[i].relevance_score` positionally
         * would attach the best score to the first passage on every query.
         *
         * That mistake is invisible in a smoke test: the scores are real, the
         * distribution looks right, and the trace table renders. It just ranks
         * by input order instead of relevance, which is the one thing this
         * component exists to avoid.
         */
        const scores = new Array<number>(passages.length).fill(
          // A passage the gateway omitted scores below the floor rather than at
          // it. Absent is not "borderline"; it is "no opinion", and admitting
          // it to the context on a default of 0 would be inventing a judgement.
          Number.NEGATIVE_INFINITY,
        );

        for (const result of results) {
          const index = result.index;
          const value = result.relevance_score;
          if (
            typeof index !== "number" ||
            index < 0 ||
            index >= passages.length ||
            typeof value !== "number" ||
            !Number.isFinite(value)
          ) {
            continue;
          }
          scores[index] = value;
        }

        return scores;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
