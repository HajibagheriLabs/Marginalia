import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@/lib/auth";
import { rateLimitNotice } from "@/lib/limits";
import { clientAddress, take } from "@/lib/rate-limit";

/**
 * Every Better Auth endpoint: sign-up, sign-in, sign-out, email verification,
 * password reset, and the OAuth callbacks if a provider is ever added.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE CREDENTIAL ENDPOINTS ARE THROTTLED, AND THEY ARE THROTTLED BY ADDRESS.
 *
 * Everything else in this application is rate limited per USER, because
 * everything else happens after a session exists. Sign-in is the one endpoint
 * whose whole purpose is to be called by someone who is not yet anybody — so a
 * per-account bucket is the wrong key twice over. It would let an attacker get
 * a fresh allowance with every email address they guess, and it would let one
 * attacker lock a real user out of their own account by exhausting their
 * bucket on purpose.
 *
 * Per IP, it costs an attacker an address per few attempts. That is not a
 * defence against a botnet, and it is not claimed to be: Better Auth already
 * hashes passwords with a slow KDF and requires a verified address before it
 * issues a session. This is the cheap layer that turns an unbounded online
 * guessing loop into a bounded one.
 *
 * THE DEMO ACCOUNT is not special-cased here, and that is deliberate. Its
 * credentials are published, so it looks like the account most worth
 * throttling — but this route cannot tell which account a request is for
 * without reading the body, and the body is a stream that Better Auth has to
 * read afterwards. The previous version guessed, applying a stricter bucket to
 * EVERY sign-in whenever a demo account existed, which penalised real users for
 * the demo's existence.
 *
 * The published credential has its own front door instead: `/demo` mints the
 * session, and that route applies `BUCKETS.demoPerIp` per address, where it can
 * do so without guessing.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS WRAPS THE HANDLER INSTEAD OF USING BETTER AUTH'S OWN LIMITER
 *
 * Better Auth ships a rate limiter, and it is a good one — but it keeps its
 * counters in the database by default, which turns every sign-in attempt,
 * including the refused ones, into writes against a free-tier Postgres. The
 * limiter in src/lib/rate-limit.ts is already in this process, already used by
 * the chat and upload routes, and costs nothing per attempt. One limiter with
 * one upgrade path is also one thing to move when this becomes Upstash.
 */

const handlers = toNextJsHandler(auth.handler);

export const { GET } = handlers;

/**
 * Which POSTs are credential attempts.
 *
 * Matched on the path rather than the body: the body is a stream that can only
 * be read once, and reading it here to inspect it would consume it before
 * Better Auth ever sees it. Sign-out, session refresh, and the callbacks are
 * deliberately not throttled — they are not guessable and they are called on
 * ordinary navigation.
 */
const THROTTLED = [
  "/sign-in/email",
  "/sign-up/email",
  "/forget-password",
  "/reset-password",
];

export async function POST(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (THROTTLED.some((route) => pathname.endsWith(route))) {
    const attempt = take("signIn", clientAddress(request));
    if (!attempt.ok) return refuse(attempt.resetAt);
  }

  return handlers.POST(request);
}

function refuse(resetAt: Date): Response {
  const notice = rateLimitNotice("sign-in attempts", resetAt);
  return Response.json(
    // Better Auth's client surfaces `message` from an error body, so the
    // sentence the user reads is the one written in limits.ts rather than a
    // bare status code.
    { message: `${notice.message} ${notice.nextStep}`, limit: notice },
    {
      status: 429,
      headers: {
        "retry-after": String(
          Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000)),
        ),
      },
    },
  );
}
