import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { APICallError } from "ai";
import type { LanguageModel } from "ai";

import { env } from "@/lib/env";

/**
 * THE FREE MODEL POOL.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A POOL AND NOT A MODEL
 *
 * OpenRouter's free tier is not a product with an SLA; it is capacity someone
 * is donating. Three things follow, and every one of them is routine rather
 * than exceptional:
 *
 *   - MODELS DISAPPEAR. A `:free` id that worked last week returns 404 today,
 *     with no deprecation notice and no migration path. The live list is at
 *     https://openrouter.ai/models?max_price=0 and it genuinely churns.
 *   - THE QUOTA IS SHARED AND SMALL. Roughly 20 requests per minute and — on
 *     an account with no purchased credits, which is this one — 50 per DAY
 *     across the whole free pool, not per model and not per user. Measured
 *     from OpenRouter's own 429 body; see FREE_POOL in src/lib/limits.ts. Two
 *     people using the app at once can exhaust a minute's budget.
 *   - CAPACITY IS BEST-EFFORT. 502s and 503s from an overloaded upstream are
 *     ordinary, not incidents.
 *
 * A single configured model would therefore be down often, and the failure
 * would reach the user as a generic error on a product that looks broken. So
 * the model is a LIST, tried in order, and the one that actually served the
 * answer is recorded on the message row — because "which model wrote this"
 * stops being a constant the moment failover exists.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT FAILOVER MUST NEVER DO
 *
 * Fail over to a PAID model. That would turn a rate limit into a bill, silently,
 * on exactly the day the app got popular enough to hit the limit. Every id in
 * this pool is validated `:free` at boot in `env.ts` — before a request can be
 * made, not while one is failing — and there is no code path here that
 * constructs a model id from anything but that validated list.
 */

/** One client per process. It is a thin wrapper over fetch; this is config reuse. */
let provider: ReturnType<typeof createOpenRouter> | null = null;

function getProvider() {
  provider ??= createOpenRouter({ apiKey: env.OPENROUTER_API_KEY });
  return provider;
}

/**
 * The ordered pool: the configured model, then its fallbacks.
 *
 * Deduplicated, because a fallback list that repeats the primary would spend a
 * whole attempt re-asking a model that just returned 429 — and rate limits do
 * not clear inside one request.
 */
export function modelPool(): string[] {
  return [...new Set([env.OPENROUTER_MODEL, ...env.OPENROUTER_FALLBACK_MODELS])];
}

export function languageModel(modelId: string): LanguageModel {
  return getProvider().chat(modelId);
}

/**
 * Is this failure worth trying the next model for?
 *
 * The distinction that matters is between "this model is unavailable" and
 * "this request is wrong". Retrying the second across four models turns one
 * bad request into four, spends four slots of a 20-per-minute shared budget,
 * and returns the same error four times slower.
 *
 *   404  the model was delisted — the canonical free-tier failure
 *   429  rate limited, shared pool exhausted; another model may have headroom
 *   5xx  upstream capacity, transient by nature
 *   408  timeout
 *
 * NOT failed over:
 *
 *   401/403  the API key is wrong or lacks access. Every model will say the
 *            same thing, and the fix is configuration, not another attempt.
 *   400/422  malformed request — a prompt too long for the context window is
 *            the realistic case, and it will be too long for the next model
 *            too. Worth surfacing rather than hiding behind three retries.
 */
export function isFailoverWorthy(error: unknown): boolean {
  if (!APICallError.isInstance(error)) {
    // A transport-level failure — DNS, socket reset, aborted upstream. Not
    // attributable to the request, so another model is a reasonable try.
    return error instanceof Error && error.name !== "AbortError";
  }

  const status = error.statusCode;
  if (status === undefined) return true;
  if (status === 404 || status === 408 || status === 429) return true;
  return status >= 500;
}

/** Why the pool gave up, for the message the user reads. */
export type PoolFailure = "rate_limited" | "unavailable" | "misconfigured";

export function classifyFailure(errors: unknown[]): PoolFailure {
  const statuses = errors
    .filter((error) => APICallError.isInstance(error))
    .map((error) => (error as APICallError).statusCode);

  if (statuses.some((status) => status === 429)) return "rate_limited";
  if (statuses.some((status) => status === 401 || status === 403)) {
    return "misconfigured";
  }
  return "unavailable";
}

/**
 * What the user is told when every model in the pool has failed.
 *
 * Specific, and never a generic 500. "Something went wrong" tells a person
 * nothing about whether to wait, retry, or give up — and the honest answers
 * here are different enough to matter: a rate limit clears in a minute, a
 * delisted pool needs a config change, and a bad key needs an operator.
 *
 * Note what these do NOT do: apologise, or offer to use a paid model.
 */
export function poolFailureMessage(failure: PoolFailure): string {
  switch (failure) {
    case "rate_limited":
      return (
        "The free model pool is rate-limited right now. Try again in a minute — " +
        "the limit is shared across everyone using free models, not just this app."
      );
    case "misconfigured":
      return (
        "The model gateway rejected this app's credentials. Check OPENROUTER_API_KEY."
      );
    case "unavailable":
      return (
        "No free model is answering right now. They are delisted without notice — " +
        "check https://openrouter.ai/models?max_price=0 and update OPENROUTER_MODEL " +
        "and OPENROUTER_FALLBACK_MODELS if the configured ones are gone."
      );
  }
}
