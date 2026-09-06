import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FREE_POOL,
  LIMITS,
  UPLOAD_LIMIT_LABEL,
  documentLimitNotice,
  freePoolNotice,
  isLimitNotice,
  messageLimitNotice,
  pageLimitNotice,
  startOfNextUtcDay,
  startOfUtcDay,
  startOfUtcMonth,
  uploadSizeNotice,
} from "./limits";

/**
 * THE LIMIT CONFIG.
 *
 * Two things are worth asserting about a file of constants and sentence
 * builders, and neither is "does 25 equal 25".
 *
 * FIRST, every notice must carry a REAL NEXT STEP. That is the product rule
 * this file exists to keep: a limit dialog whose advice is "try again later"
 * is a dead end, and the only way to stop one appearing is to assert that
 * every builder produces one.
 *
 * SECOND, the day boundary is UTC everywhere. The per-user question counter
 * and the shared model quota have to reset at the same instant, because one
 * settings page explains both — and because OpenRouter's own daily quota rolls
 * over at UTC midnight. A local boundary would put the app's arithmetic hours
 * out of step with the ceiling it is protecting.
 */

describe("the notices", () => {
  const notices = [
    documentLimitNotice(LIMITS.documents),
    pageLimitNotice(LIMITS.totalPages - 10, 40),
    messageLimitNotice(LIMITS.messagesPerDay, new Date()),
    uploadSizeNotice(40 * 1024 * 1024),
    freePoolNotice("day", FREE_POOL.requestsPerDay, new Date()),
    freePoolNotice("minute", FREE_POOL.requestsPerMinute, new Date()),
  ];

  it("every one names a next step", () => {
    for (const notice of notices) {
      expect(notice.nextStep.length).toBeGreaterThan(0);
      // "Try again later" on its own is the thing this rule exists to prevent.
      expect(notice.nextStep.toLowerCase()).not.toBe("try again later.");
    }
  });

  it("every one states the ceiling and where the account stands", () => {
    for (const notice of notices) {
      expect(notice.message).toMatch(/\d/);
      expect(isLimitNotice(notice)).toBe(true);
    }
  });

  it("never apologises", () => {
    for (const notice of notices) {
      const text = `${notice.title} ${notice.message} ${notice.nextStep}`;
      expect(text.toLowerCase()).not.toMatch(/sorry|apolog|oops|unfortunately/);
    }
  });

  it("never offers a paid model when the free pool is spent", () => {
    // The app runs with no card on file. "Upgrade to continue" would be an
    // offer it cannot honour, and there is no code path behind it.
    const spent = freePoolNotice("day", FREE_POOL.requestsPerDay, new Date());
    const text = `${spent.title} ${spent.message} ${spent.nextStep}`;
    expect(text.toLowerCase()).not.toMatch(/upgrade|paid|billing|subscribe/);
    expect(spent.title).toContain("exhausted for today");
  });

  it("carries a reset time only for limits that clear by themselves", () => {
    expect(messageLimitNotice(100, new Date()).resetAt).toBeDefined();
    expect(freePoolNotice("day", 200, new Date()).resetAt).toBeDefined();
    // Deleting a document is what clears these; waiting is not.
    expect(documentLimitNotice(25).resetAt).toBeUndefined();
    expect(pageLimitNotice(2000, 1).resetAt).toBeUndefined();
  });
});

describe("isLimitNotice", () => {
  it("rejects anything that is not one", () => {
    // The guard runs over a JSON body parsed out of a transport error message,
    // so it has to survive genuinely arbitrary input.
    for (const value of [null, undefined, 0, "", [], {}, { key: "documents" }]) {
      expect(isLimitNotice(value)).toBe(false);
    }
  });
});

describe("UTC windows", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses UTC midnight regardless of the machine's zone", () => {
    // 23:30 UTC. In any zone east of UTC the local date is already tomorrow —
    // which is exactly the case a `new Date().setHours(0,0,0,0)` gets wrong.
    vi.setSystemTime(new Date("2026-03-10T23:30:00.000Z"));

    expect(startOfUtcDay().toISOString()).toBe("2026-03-10T00:00:00.000Z");
    expect(startOfNextUtcDay().toISOString()).toBe("2026-03-11T00:00:00.000Z");
  });

  it("puts the next boundary exactly 24 hours after the current one", () => {
    vi.setSystemTime(new Date("2026-03-10T12:00:00.000Z"));
    expect(
      startOfNextUtcDay().getTime() - startOfUtcDay().getTime(),
    ).toBe(24 * 60 * 60 * 1000);
  });

  it("starts the month at the first, in UTC", () => {
    vi.setSystemTime(new Date("2026-03-01T00:30:00.000Z"));
    expect(startOfUtcMonth().toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });
});

describe("the numbers", () => {
  it("states the upload ceiling once, and derives its label", () => {
    // The label is what the dropzone and every rejection message read. Writing
    // "25 MB" beside a constant is how the two come to disagree.
    expect(UPLOAD_LIMIT_LABEL).toBe(
      `${LIMITS.uploadBytes / (1024 * 1024)} MB`,
    );
  });
});
