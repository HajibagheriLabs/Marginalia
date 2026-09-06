import { BUCKETS, FREE_POOL, startOfNextUtcDay, type BucketName } from "./limits";

/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THE LIMITER. In-memory, per instance, and honest about it.               │
 * │                                                                          │
 * │ WHAT THIS IS: token buckets keyed by user or by IP, plus two global      │
 * │ counters for the shared OpenRouter free-tier ceilings. One `Map`, one    │
 * │ sweep, no dependencies, no network hop on the request path.              │
 * │                                                                          │
 * │ WHAT IT IS NOT: distributed. State lives in the process, so N warm       │
 * │ Vercel instances enforce a limit up to N times looser than configured,   │
 * │ and a cold start forgets everything. That is a real weakness and it is   │
 * │ written here rather than discovered later.                               │
 * │                                                                          │
 * │ It is nonetheless the right call for this deployment, for two reasons.   │
 * │ First, the limits it enforces are not the security boundary: ownership   │
 * │ is, and that lives in Postgres. This throttles; it does not authorise.   │
 * │ Second, the DURABLE limits — 25 documents, 2,000 pages, 100 questions a  │
 * │ day — are counted in Postgres inside the same transaction as the write   │
 * │ they constrain (see src/lib/usage/guard.ts), so a forgotten bucket costs │
 * │ a few extra requests and never an extra document or an extra message.    │
 * │ The buckets exist to stop a burst, and a burst is bounded by the         │
 * │ database anyway.                                                         │
 * │                                                                          │
 * │ ── UPGRADE PATH: UPSTASH REDIS ────────────────────────────────────────  │
 * │ Upstash has a free tier and a serverless HTTP client, so this becomes    │
 * │ shared state without leaving the free-tier constraint of this project:   │
 * │                                                                          │
 * │   npm i @upstash/ratelimit @upstash/redis                                │
 * │                                                                          │
 * │   const limiter = new Ratelimit({                                        │
 * │     redis: Redis.fromEnv(),                                              │
 * │     limiter: Ratelimit.tokenBucket(                                      │
 * │       BUCKETS.chat.refillPerMinute, "1 m", BUCKETS.chat.capacity),       │
 * │     prefix: "marginalia:chat",                                           │
 * │   });                                                                    │
 * │   const { success, reset, remaining } = await limiter.limit(userId);     │
 * │                                                                          │
 * │ The swap is contained to this file: `take`, `release`, and `countFree`   │
 * │ keep their signatures and become `async`, callers add an `await`, and    │
 * │ UPSTASH_REDIS_REST_URL / _TOKEN join src/lib/env.ts and .env.example.    │
 * │ The free-pool counters below become `Ratelimit.fixedWindow` on a single  │
 * │ shared key, which is also what makes them CORRECT rather than            │
 * │ approximate — see the note on `countFreePoolRequest`.                    │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

/** What a bucket says when asked for a token. */
export interface RateDecision {
  ok: boolean;
  /** Whole tokens left after this call. */
  remaining: number;
  /** When the next token becomes available. Only meaningful when `ok` is false. */
  resetAt: Date;
}

interface Bucket {
  /** Fractional tokens; refill is continuous, not stepped. */
  tokens: number;
  updatedAt: number;
}

interface Window {
  count: number;
  /** Epoch ms at which this window ends and the count resets. */
  endsAt: number;
}

/**
 * Survives Next.js hot reloads in development.
 *
 * Without this, every edit would hand out a fresh set of full buckets, and a
 * rate limit that resets whenever you save a file is a rate limit you cannot
 * test.
 */
const globalForLimiter = globalThis as unknown as {
  marginaliaBuckets?: Map<string, Bucket>;
  marginaliaWindows?: Map<string, Window>;
};

const buckets = (globalForLimiter.marginaliaBuckets ??= new Map());
const windows = (globalForLimiter.marginaliaWindows ??= new Map());

/**
 * Drop buckets nobody has touched in an hour.
 *
 * A `Map` keyed by user id grows with every user who ever signed in, and a
 * long-lived instance would hold one entry per visitor forever. A full bucket
 * and a missing bucket are indistinguishable to a caller, so eviction is free:
 * anything idle long enough to be swept had refilled to capacity anyway.
 *
 * Swept lazily, on write, rather than on a timer — a `setInterval` in a
 * serverless function keeps the instance from suspending.
 */
const SWEEP_AFTER_MS = 60 * 60 * 1000;
let lastSweep = 0;

function sweep(now: number): void {
  if (now - lastSweep < SWEEP_AFTER_MS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (now - bucket.updatedAt > SWEEP_AFTER_MS) buckets.delete(key);
  }
  for (const [key, window] of windows) {
    if (now > window.endsAt) windows.delete(key);
  }
}

/**
 * Take one token from a bucket, or refuse.
 *
 * `name` selects the configured capacity and refill rate; `key` is the subject
 * — a user id, or an IP address for the buckets that are keyed by address.
 * Keeping them separate is what stops one user's chat bucket and their upload
 * bucket from sharing a counter.
 */
export function take(name: BucketName, key: string): RateDecision {
  const config = BUCKETS[name];
  const now = Date.now();
  sweep(now);

  const id = `${name}:${key}`;
  const bucket = buckets.get(id) ?? { tokens: config.capacity, updatedAt: now };

  // Continuous refill: tokens accrue by elapsed time rather than in steps at a
  // window boundary. That is the whole reason this is a bucket — a burst is
  // absorbed once and then paid back gradually, instead of the limit snapping
  // wide open every sixty seconds.
  const refilled = ((now - bucket.updatedAt) / 60_000) * config.refillPerMinute;
  const tokens = Math.min(config.capacity, bucket.tokens + refilled);

  if (tokens < 1) {
    // Do NOT write `updatedAt` forward on a refusal without carrying the
    // accrued tokens with it — that would silently reset the refill clock and
    // a client retrying in a tight loop would never recover a token.
    buckets.set(id, { tokens, updatedAt: now });
    const waitMs = ((1 - tokens) / config.refillPerMinute) * 60_000;
    return {
      ok: false,
      remaining: 0,
      resetAt: new Date(now + Math.ceil(waitMs)),
    };
  }

  buckets.set(id, { tokens: tokens - 1, updatedAt: now });
  return {
    ok: true,
    remaining: Math.floor(tokens - 1),
    resetAt: new Date(now),
  };
}

/**
 * Give a token back.
 *
 * Called when a request that took one did no work — the overwhelming case
 * being a stream the user aborted before the model produced anything. Charging
 * for an answer nobody received would make pressing "stop" a punishment, and
 * the point of stop is that it costs less, not more.
 *
 * Capped at capacity so a double release cannot mint tokens.
 */
export function release(name: BucketName, key: string): void {
  const config = BUCKETS[name];
  const id = `${name}:${key}`;
  const bucket = buckets.get(id);
  if (!bucket) return;
  buckets.set(id, {
    tokens: Math.min(config.capacity, bucket.tokens + 1),
    updatedAt: bucket.updatedAt,
  });
}

/** Peek at a bucket without spending a token. For the settings readout. */
export function peek(name: BucketName, key: string): number {
  const config = BUCKETS[name];
  const bucket = buckets.get(`${name}:${key}`);
  if (!bucket) return config.capacity;
  const refilled =
    ((Date.now() - bucket.updatedAt) / 60_000) * config.refillPerMinute;
  return Math.floor(Math.min(config.capacity, bucket.tokens + refilled));
}

/* ========================================================================== *
 * THE FREE-TIER CEILING
 * ========================================================================== */

export interface FreePoolDecision {
  ok: boolean;
  /** Which ceiling stopped it. Null when `ok`. */
  scope: "minute" | "day" | null;
  usedThisMinute: number;
  usedToday: number;
  resetAt: Date;
}

/**
 * Count one model request against OpenRouter's free ceilings, or refuse it.
 *
 * GLOBAL, not per user: the ~20/min and ~200/day quotas belong to this app's
 * OpenRouter key and are spent by whoever calls it. So both counters are kept
 * on a single shared key rather than one per user, which is also why they are
 * the part of this file that suffers most from being in-memory — N instances
 * each count their own share and the true total is their sum. It fails in the
 * safe direction for the daily quota (each instance refuses at its own 200
 * before the account's 200 is reached only if traffic is on one instance;
 * spread across several, upstream 429s are still caught by the model pool's
 * failover and reported honestly) and it is the first thing the Upstash swap
 * above fixes properly.
 *
 * Counted BEFORE the request rather than after, so a burst of concurrent
 * questions cannot all pass a check that only the first one's completion would
 * have closed.
 */
export function countFreePoolRequest(): FreePoolDecision {
  const now = Date.now();
  sweep(now);

  const minute = readWindow("openrouter:minute", now, 60_000);
  const day = readWindow("openrouter:day", now, startOfNextUtcDay().getTime() - now);

  if (day.count >= FREE_POOL.requestsPerDay) {
    return {
      ok: false,
      scope: "day",
      usedThisMinute: minute.count,
      usedToday: day.count,
      resetAt: new Date(day.endsAt),
    };
  }

  if (minute.count >= FREE_POOL.requestsPerMinute) {
    return {
      ok: false,
      scope: "minute",
      usedThisMinute: minute.count,
      usedToday: day.count,
      resetAt: new Date(minute.endsAt),
    };
  }

  minute.count += 1;
  day.count += 1;
  windows.set("openrouter:minute", minute);
  windows.set("openrouter:day", day);

  return {
    ok: true,
    scope: null,
    usedThisMinute: minute.count,
    usedToday: day.count,
    resetAt: new Date(day.endsAt),
  };
}

/** Hand a free-pool slot back when the request it was taken for did nothing. */
export function releaseFreePoolRequest(): void {
  for (const key of ["openrouter:minute", "openrouter:day"]) {
    const window = windows.get(key);
    if (window && window.count > 0) {
      windows.set(key, { ...window, count: window.count - 1 });
    }
  }
}

/** The current free-pool state, without spending anything. */
export function freePoolState(): { usedThisMinute: number; usedToday: number; resetAt: Date } {
  const now = Date.now();
  const minute = readWindow("openrouter:minute", now, 60_000, false);
  const day = readWindow(
    "openrouter:day",
    now,
    startOfNextUtcDay().getTime() - now,
    false,
  );
  return {
    usedThisMinute: minute.count,
    usedToday: day.count,
    resetAt: new Date(day.endsAt),
  };
}

/**
 * The current window for a key, rolled over if the previous one has expired.
 *
 * `persist` is false for read-only peeks so that looking at the settings page
 * cannot create windows.
 */
function readWindow(
  key: string,
  now: number,
  durationMs: number,
  persist = true,
): Window {
  const existing = windows.get(key);
  if (existing && now < existing.endsAt) return existing;
  const fresh: Window = { count: 0, endsAt: now + durationMs };
  if (persist) windows.set(key, fresh);
  return fresh;
}

/* ========================================================================== *
 * IDENTIFYING THE CALLER
 * ========================================================================== */

/**
 * The client's address, as far as it can be known.
 *
 * `x-forwarded-for` is a client-settable header everywhere EXCEPT behind a
 * proxy that overwrites it, which Vercel does — it appends the real peer and
 * `x-real-ip` carries it alone. So this is trustworthy in production and
 * spoofable in local development, which is the right trade for a throttle:
 * the durable limits do not depend on it, and the alternative is not
 * throttling by address at all.
 *
 * The LEFTMOST entry is taken because Vercel's edge appends, so the original
 * client sits at the front. On a self-hosted deployment behind a different
 * proxy, check that assumption before trusting this.
 */
export function clientAddress(request: Request): string {
  const real = request.headers.get("x-real-ip");
  if (real) return real.trim();

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }

  // No address at all. One shared bucket is stricter than no bucket, and an
  // unidentifiable caller is exactly the one to be strict with.
  return "unknown";
}
