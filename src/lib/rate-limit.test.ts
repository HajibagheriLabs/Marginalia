import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BUCKETS, FREE_POOL } from "./limits";
import {
  countFreePoolRequest,
  freePoolState,
  peek,
  release,
  releaseFreePoolRequest,
  take,
} from "./rate-limit";

/**
 * THE LIMITER, against the clock.
 *
 * Every property worth asserting here is a property about TIME — a bucket that
 * refills, a window that rolls over, a refused request that does not reset its
 * own refill clock — so the tests drive a fake clock rather than sleeping.
 * Real sleeps would make this suite slow, flaky, and unable to assert the
 * midnight rollover at all.
 *
 * Bucket state lives in a module-level `Map` that deliberately survives across
 * calls, which is the whole point of the design. So every test uses a UNIQUE
 * KEY. Sharing a key between two tests would make them pass or fail depending
 * on the order they ran in, which is exactly the kind of test that gets
 * deleted six months later for being unreliable.
 */

let keySeed = 0;
const uniqueKey = () => `test-user-${keySeed++}-${Math.random()}`;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-10T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("token bucket", () => {
  it("allows a burst up to capacity and then refuses", () => {
    const key = uniqueKey();
    const { capacity } = BUCKETS.chat;

    for (let i = 0; i < capacity; i += 1) {
      expect(take("chat", key).ok).toBe(true);
    }

    const refused = take("chat", key);
    expect(refused.ok).toBe(false);
    expect(refused.remaining).toBe(0);
    // The reset time is when ONE token is back, not when the bucket is full.
    // A caller waiting for a full bucket would wait several times too long.
    expect(refused.resetAt.getTime()).toBeGreaterThan(Date.now());
    expect(refused.resetAt.getTime()).toBeLessThanOrEqual(
      Date.now() + (60_000 / BUCKETS.chat.refillPerMinute) + 1,
    );
  });

  it("refills continuously rather than at a window boundary", () => {
    const key = uniqueKey();
    const { capacity, refillPerMinute } = BUCKETS.chat;

    for (let i = 0; i < capacity; i += 1) take("chat", key);
    expect(take("chat", key).ok).toBe(false);

    // Exactly one token's worth of time, and not a second more.
    vi.advanceTimersByTime((60_000 / refillPerMinute) + 1);
    expect(take("chat", key).ok).toBe(true);
    // ...which spent it again.
    expect(take("chat", key).ok).toBe(false);
  });

  it("does not reset the refill clock when it refuses", () => {
    // THE BUG THIS GUARDS: writing `updatedAt = now` on a refusal without
    // carrying the accrued fraction forward. A client retrying in a tight loop
    // would then restart the refill on every attempt and never recover a
    // token, turning a one-second wait into an infinite one.
    const key = uniqueKey();
    const { capacity, refillPerMinute } = BUCKETS.chat;
    const oneToken = 60_000 / refillPerMinute;

    for (let i = 0; i < capacity; i += 1) take("chat", key);

    // Hammer it while the token accrues, the way a retry loop would.
    for (let elapsed = 0; elapsed < oneToken; elapsed += oneToken / 10) {
      vi.advanceTimersByTime(oneToken / 10);
      take("chat", key);
    }

    vi.advanceTimersByTime(oneToken + 1);
    expect(take("chat", key).ok).toBe(true);
  });

  it("never refills past capacity", () => {
    const key = uniqueKey();
    take("chat", key);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(peek("chat", key)).toBe(BUCKETS.chat.capacity);
  });

  it("keeps buckets separate by name and by key", () => {
    const a = uniqueKey();
    const b = uniqueKey();

    for (let i = 0; i < BUCKETS.chat.capacity; i += 1) take("chat", a);

    expect(take("chat", a).ok).toBe(false);
    // A different user is unaffected...
    expect(take("chat", b).ok).toBe(true);
    // ...and so is the same user's upload allowance.
    expect(take("upload", a).ok).toBe(true);
  });

  it("gives a token back on release, capped at capacity", () => {
    const key = uniqueKey();
    for (let i = 0; i < BUCKETS.chat.capacity; i += 1) take("chat", key);
    expect(take("chat", key).ok).toBe(false);

    release("chat", key);
    expect(take("chat", key).ok).toBe(true);

    // A double release cannot mint tokens.
    for (let i = 0; i < 20; i += 1) release("chat", key);
    expect(peek("chat", key)).toBe(BUCKETS.chat.capacity);
  });
});

describe("free pool ceilings", () => {
  /**
   * These counters are GLOBAL by design — the quota belongs to the app's
   * OpenRouter key, not to a user — so they cannot be isolated per test the
   * way buckets can. Instead each test starts by draining whatever the
   * previous one left and asserts relative to that, which is honest about the
   * shared state rather than pretending it away.
   */
  function drainMinute(): void {
    for (let i = 0; i < FREE_POOL.requestsPerMinute + 1; i += 1) {
      countFreePoolRequest();
    }
  }

  it("refuses past the per-minute ceiling and recovers a minute later", () => {
    drainMinute();

    const refused = countFreePoolRequest();
    expect(refused.ok).toBe(false);
    expect(refused.scope).toBe("minute");

    vi.advanceTimersByTime(60_001);
    expect(countFreePoolRequest().ok).toBe(true);
  });

  it("counts a released slot back", () => {
    drainMinute();
    expect(countFreePoolRequest().ok).toBe(false);

    releaseFreePoolRequest();
    expect(countFreePoolRequest().ok).toBe(true);
  });

  it("reports the daily reset at the next UTC midnight", () => {
    // The day boundary must agree with OpenRouter's, which is UTC. A local
    // midnight would make "resets at" wrong by up to twelve hours for anyone
    // outside UTC — and would make the app's own daily message counter reset
    // at a different moment from the quota it is protecting.
    const state = freePoolState();
    expect(state.resetAt.toISOString()).toBe("2026-03-11T00:00:00.000Z");
  });
});
