/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ EVERY PER-USER LIMIT IN THIS APPLICATION, IN ONE FILE.                   │
 * │                                                                          │
 * │ Not "most of them". A limit that lives next to the code it constrains is │
 * │ a limit nobody can audit: you cannot answer "what is this app's ceiling  │
 * │ on X" without reading every route, and the settings page cannot show a   │
 * │ number it has to go looking for. So the numbers are HERE, the sentences  │
 * │ that explain them are HERE, and the enforcement points import them.      │
 * │                                                                          │
 * │ THIS FILE IS ISOMORPHIC. It has no database import, no `env` import, and │
 * │ no side effects, so the browser can read the same constants the server   │
 * │ enforces — the dropzone rejects a 40 MB file before spending the user's  │
 * │ bandwidth, and the settings page renders the ceilings without a round    │
 * │ trip. The client's answer is a courtesy; the server's answer is the      │
 * │ decision. Every limit below is enforced server-side, INSIDE the same     │
 * │ transaction as the write it constrains, and the comment on each limit    │
 * │ names that enforcement point.                                            │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

/**
 * The ceilings.
 *
 * These are free-tier numbers, chosen so that one enthusiastic user cannot
 * spend Neon's row budget, Qdrant's vector budget, Blob's storage, or the
 * shared OpenRouter free pool for everybody else. They are deliberately
 * generous enough that an honest reviewer of this project never meets one.
 */
export const LIMITS = {
  /**
   * Documents a user may hold at once. Soft-deleted documents do not count.
   *
   * Enforced in: `insertDocumentWithinLimit` (src/lib/usage/guard.ts), which
   * counts and inserts in ONE transaction under a per-user advisory lock, and
   * pre-checked when the Blob upload token is minted.
   */
  documents: 25,

  /**
   * Pages across every document a user holds. The real cost driver: pages
   * become chunks, chunks become vectors, and vectors are the scarcest free
   * tier in the stack.
   *
   * Enforced in: `assertPageAllowance` (src/lib/usage/guard.ts), called inside
   * the transaction that writes `document_pages` in the extraction stage — the
   * first moment a document's true page count is known.
   */
  totalPages: 2_000,

  /**
   * Questions a user may ask per UTC day. Counts `messages` rows with
   * role='user', so regenerating an answer to an existing question does not
   * spend a second one.
   *
   * Enforced in: `insertUserMessageWithinLimit` (src/lib/usage/guard.ts),
   * which counts and inserts in one transaction under the same advisory lock,
   * called from the chat route before any retrieval happens.
   */
  messagesPerDay: 100,

  /**
   * Bytes in a single upload. 25 MB.
   *
   * Enforced in: the Blob token's `maximumSizeInBytes`, where the STORE
   * rejects the transfer rather than trusting a claim; re-checked against the
   * stored object's real size in `registerUploadedDocument`; and pre-checked
   * in the browser by `validateUpload` so a doomed 40 MB upload never starts.
   */
  uploadBytes: 25 * 1024 * 1024,
} as const;

/** "25 MB" — the sentence form, so the number itself is written once. */
export const UPLOAD_LIMIT_LABEL = `${LIMITS.uploadBytes / (1024 * 1024)} MB`;

/**
 * OPENROUTER'S FREE CEILINGS, as published for the free model pool.
 *
 * These are NOT per user. The quota belongs to this application's OpenRouter
 * account and is shared by everyone using it, which is why it is counted
 * globally in the same limiter as the per-user buckets rather than alongside
 * the per-user limits above.
 *
 * The published figures are roughly 20 requests per minute and 200 per day
 * (https://openrouter.ai/docs/api-reference/limits). Counting them here is
 * what lets the app say "the free model pool is exhausted for today" WITH a
 * reset time, instead of discovering it as a wall of 429s from upstream.
 * Hitting our own counter produces a written sentence; hitting theirs produces
 * an error.
 */
export const FREE_POOL = {
  requestsPerMinute: 20,
  requestsPerDay: 200,
} as const;

/**
 * TOKEN BUCKETS. Burst capacity, then a steady refill.
 *
 * A bucket rather than a fixed window because real use is bursty: someone asks
 * three questions in twenty seconds and then reads for five minutes. A fixed
 * window at the same average rate would refuse the third question; a bucket
 * absorbs the burst and then throttles anyone who keeps going.
 *
 * `capacity` is how many requests may be made back to back from rest.
 * `refillPerMinute` is the sustained rate.
 */
export const BUCKETS = {
  /** Asking a question. Bounded by `messagesPerDay` over the long run. */
  chat: { capacity: 6, refillPerMinute: 12 },
  /** Requesting a Blob upload token. Bounded by `documents` over the long run. */
  upload: { capacity: 5, refillPerMinute: 10 },
  /**
   * Sign-in, PER IP. Credential stuffing is what this exists for, so it is
   * keyed by address rather than by account — an attacker chooses the account
   * name and would otherwise get a fresh bucket with every guess.
   */
  signIn: { capacity: 8, refillPerMinute: 4 },
  /**
   * THE DEMO ACCOUNT, per IP, stricter than everything above.
   *
   * Its credentials are published so a reviewer can sign in without
   * registering — which means they are published to everyone else too. The
   * per-user buckets are useless there, because every visitor is the same
   * user, so the demo account is additionally throttled per address.
   */
  demoPerIp: { capacity: 3, refillPerMinute: 3 },
} as const;

export type BucketName = keyof typeof BUCKETS;

/* ========================================================================== *
 * WHAT THE USER IS TOLD
 * ========================================================================== */

export type LimitKey =
  | "documents"
  | "pages"
  | "messagesPerDay"
  | "uploadBytes"
  | "rate"
  | "freePool";

/**
 * A blocked action, described well enough to render a dialog from.
 *
 * NOT an error string. A limit is not a failure — nothing went wrong, the user
 * asked for something this account cannot currently do — and the difference is
 * visible in the interface: an error is a toast that disappears, a limit is a
 * dialog that names the exact ceiling, the current usage, and the one action
 * that clears it. "Something went wrong" would be a lie here.
 *
 * `current` and `limit` travel as numbers rather than baked into the sentence,
 * so the dialog can set them in the mono face — which is where every number in
 * this design system belongs.
 */
export interface LimitNotice {
  key: LimitKey;
  /** A statement of fact, sentence case, no apology. */
  title: string;
  /** What the ceiling is, and where this account stands against it. */
  message: string;
  /** The ONE thing to do next. Never "try again later" on its own. */
  nextStep: string;
  limit: number;
  current: number;
  /** For the "12 / 25 documents" readout. */
  unit: string;
  /** ISO 8601. Present only when the limit clears by itself. */
  resetAt?: string;
}

/** Type guard for a notice that crossed the wire as JSON. */
export function isLimitNotice(value: unknown): value is LimitNotice {
  if (typeof value !== "object" || value === null) return false;
  const notice = value as Partial<LimitNotice>;
  return (
    typeof notice.key === "string" &&
    typeof notice.title === "string" &&
    typeof notice.message === "string" &&
    typeof notice.nextStep === "string" &&
    typeof notice.limit === "number" &&
    typeof notice.current === "number"
  );
}

export function documentLimitNotice(current: number): LimitNotice {
  return {
    key: "documents",
    title: "Document limit reached",
    message: `This account holds ${current} of ${LIMITS.documents} documents.`,
    nextStep: "Delete a document to upload another.",
    limit: LIMITS.documents,
    current,
    unit: "documents",
  };
}

export function pageLimitNotice(current: number, incoming: number): LimitNotice {
  return {
    key: "pages",
    title: "Page limit reached",
    message:
      `This account holds ${current.toLocaleString("en-US")} of ` +
      `${LIMITS.totalPages.toLocaleString("en-US")} pages, and this file adds ` +
      `${incoming.toLocaleString("en-US")} more.`,
    nextStep: "Delete a document to make room, then retry this one.",
    limit: LIMITS.totalPages,
    current,
    unit: "pages",
  };
}

export function messageLimitNotice(current: number, resetAt: Date): LimitNotice {
  return {
    key: "messagesPerDay",
    title: "Daily question limit reached",
    message: `You have asked ${current} of ${LIMITS.messagesPerDay} questions today.`,
    nextStep: `The count resets at ${formatReset(resetAt)}. Reading documents and opening past answers still works.`,
    limit: LIMITS.messagesPerDay,
    current,
    unit: "questions",
    resetAt: resetAt.toISOString(),
  };
}

export function uploadSizeNotice(bytes: number): LimitNotice {
  return {
    key: "uploadBytes",
    title: "File too large",
    message: `That file is ${(bytes / (1024 * 1024)).toFixed(1)} MB. The limit is ${UPLOAD_LIMIT_LABEL} per file.`,
    nextStep: "Split it, or upload just the section you want to ask about.",
    limit: LIMITS.uploadBytes,
    current: bytes,
    unit: "bytes",
  };
}

/**
 * The free model pool is spent.
 *
 * Deliberately not phrased as an error, and deliberately never offering a paid
 * model. This app runs with no card on file; "upgrade to continue" would be an
 * offer it cannot honour.
 */
export function freePoolNotice(
  scope: "minute" | "day",
  used: number,
  resetAt: Date,
): LimitNotice {
  const perDay = scope === "day";
  return {
    key: "freePool",
    title: perDay
      ? "The free model pool is exhausted for today"
      : "The free model pool is busy",
    message: perDay
      ? `This app has made ${used} of ${FREE_POOL.requestsPerDay} free-tier model requests today. That quota belongs to the app and is shared by everyone using it, not counted per account.`
      : `This app has made ${used} of ${FREE_POOL.requestsPerMinute} free-tier model requests in the last minute.`,
    nextStep: perDay
      ? `It resets at ${formatReset(resetAt)}. Your documents and past answers are unaffected.`
      : `Ask again after ${formatReset(resetAt)}.`,
    limit: perDay ? FREE_POOL.requestsPerDay : FREE_POOL.requestsPerMinute,
    current: used,
    unit: "requests",
    resetAt: resetAt.toISOString(),
  };
}

/** Too many requests, too fast, from one account or one address. */
export function rateLimitNotice(
  what: "questions" | "uploads" | "sign-in attempts",
  resetAt: Date,
): LimitNotice {
  return {
    key: "rate",
    title: "Too fast",
    message: `Too many ${what} in a short time.`,
    nextStep: `Try again after ${formatReset(resetAt)}.`,
    limit: 0,
    current: 0,
    unit: "requests",
    resetAt: resetAt.toISOString(),
  };
}

/**
 * A wall-clock time, in a locale.
 *
 * Timestamps are UTC in the database and formatted at the edge — but this
 * string is also built on the SERVER, for the body of a 429, where the
 * reader's locale is unknown. `en-US` with a named zone is the honest
 * fallback: a time with no zone is a time in somebody else's day.
 */
function formatReset(at: Date): string {
  return at.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/* ========================================================================== *
 * WINDOWS
 * ========================================================================== */

/**
 * The start of the current UTC day.
 *
 * Daily counters are UTC rather than local because the ceiling they protect is
 * OpenRouter's, and OpenRouter resets at UTC midnight. Making our boundary
 * agree with theirs is what keeps "40 questions left today" true. The per-user
 * daily message count uses the same boundary, so both readouts on the settings
 * page reset at the same moment and one sentence explains both.
 */
export function startOfUtcDay(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

export function startOfNextUtcDay(now: Date = new Date()): Date {
  return new Date(startOfUtcDay(now).getTime() + 24 * 60 * 60 * 1000);
}

/** The start of the current UTC month — the window the settings summary uses. */
export function startOfUtcMonth(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
