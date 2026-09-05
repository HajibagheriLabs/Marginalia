import { APICallError } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { classifyFailure, isFailoverWorthy, poolFailureMessage } from "./models";

/**
 * THE FREE-MODEL CONSTRAINT AND THE FAILOVER RULES.
 *
 * Two things are guarded here, and both are the kind that fail silently and
 * expensively:
 *
 *   - a paid model id must stop the process at BOOT, not at request time. By
 *     request time the money is spent and the only signal is an invoice.
 *   - failover must distinguish "this model is unavailable" from "this request
 *     is wrong". Retrying the second across the pool turns one bad request into
 *     four and burns four slots of a 20-per-minute shared budget.
 */

function apiError(statusCode: number): APICallError {
  return new APICallError({
    message: `simulated ${statusCode}`,
    url: "https://openrouter.ai/api/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
    isRetryable: statusCode === 429,
  });
}

/* ========================================================================== *
 * THE HARD CONSTRAINT
 * ========================================================================== */

describe("`:free` enforcement at boot", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("refuses to load with a paid primary model", async () => {
    vi.stubEnv("OPENROUTER_MODEL", "anthropic/claude-sonnet-5");

    // env.ts parses at module load, so importing it IS the boot check.
    await expect(import("@/lib/env")).rejects.toThrow(/:free/);
  });

  it("refuses to load when any fallback is a paid model", async () => {
    // The fallback list is the easier place for a paid id to hide: it is
    // rarely exercised, so a mistake there would only bill on the day the
    // primary model was rate-limited.
    vi.stubEnv("OPENROUTER_MODEL", "z-ai/glm-5.2:free");
    vi.stubEnv(
      "OPENROUTER_FALLBACK_MODELS",
      "minimax/minimax-m3:free,openai/gpt-4o",
    );

    await expect(import("@/lib/env")).rejects.toThrow(/:free/);
  });

  it("loads with an all-free pool, and dedupes it", async () => {
    vi.stubEnv("OPENROUTER_MODEL", "z-ai/glm-5.2:free");
    // The primary repeated in the fallbacks: re-asking a model that just
    // returned 429 wastes a whole attempt, since a rate limit does not clear
    // inside one request.
    vi.stubEnv(
      "OPENROUTER_FALLBACK_MODELS",
      "z-ai/glm-5.2:free,minimax/minimax-m3:free",
    );

    const { modelPool } = await import("./models");
    expect(modelPool()).toEqual(["z-ai/glm-5.2:free", "minimax/minimax-m3:free"]);
  });
});

/* ========================================================================== *
 * FAILOVER CLASSIFICATION
 * ========================================================================== */

describe("isFailoverWorthy", () => {
  it("fails over on the free tier's ordinary failures", () => {
    // 404 is how a delisted model presents — the canonical free-tier failure.
    expect(isFailoverWorthy(apiError(404))).toBe(true);
    expect(isFailoverWorthy(apiError(429))).toBe(true);
    expect(isFailoverWorthy(apiError(408))).toBe(true);
    expect(isFailoverWorthy(apiError(500))).toBe(true);
    expect(isFailoverWorthy(apiError(502))).toBe(true);
    expect(isFailoverWorthy(apiError(503))).toBe(true);
  });

  it("does not fail over on failures every model would repeat", () => {
    // Credentials and malformed requests are not model-specific. Trying three
    // more models returns the same answer, three times slower.
    expect(isFailoverWorthy(apiError(401))).toBe(false);
    expect(isFailoverWorthy(apiError(403))).toBe(false);
    expect(isFailoverWorthy(apiError(400))).toBe(false);
    expect(isFailoverWorthy(apiError(422))).toBe(false);
  });

  it("fails over on a transport error but never on an abort", () => {
    expect(isFailoverWorthy(new Error("socket hang up"))).toBe(true);

    // The user cancelled. Spending another model on a request nobody is
    // waiting for is pure waste.
    const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(isFailoverWorthy(aborted)).toBe(false);
  });
});

describe("poolFailureMessage", () => {
  it("tells a rate-limited user to wait, and says why", () => {
    const message = poolFailureMessage(classifyFailure([apiError(429)]));

    expect(message.toLowerCase()).toContain("rate-limited");
    expect(message.toLowerCase()).toContain("try again in a minute");
    // The limit is shared across all free-tier users, which is the part that
    // makes waiting the right advice rather than a brush-off.
    expect(message).toContain("shared");
  });

  it("points a delisted pool at the live model list", () => {
    const message = poolFailureMessage(classifyFailure([apiError(404)]));
    expect(message).toContain("https://openrouter.ai/models?max_price=0");
  });

  it("names the variable to check on a credentials failure", () => {
    const message = poolFailureMessage(classifyFailure([apiError(401)]));
    expect(message).toContain("OPENROUTER_API_KEY");
  });

  it("never offers to fall back to a paid model", () => {
    // The failure mode this whole design exists to prevent: turning a rate
    // limit into a bill on the day the app gets popular.
    for (const status of [404, 429, 401, 500]) {
      const message = poolFailureMessage(classifyFailure([apiError(status)]));
      expect(message.toLowerCase()).not.toContain("paid");
      expect(message.toLowerCase()).not.toContain("upgrade");
    }
  });

  it("reports a rate limit even when mixed with other failures", () => {
    // 429 is the one the user can act on by waiting, so it wins.
    expect(classifyFailure([apiError(500), apiError(429)])).toBe("rate_limited");
  });
});
