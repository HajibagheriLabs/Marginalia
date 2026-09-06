import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
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
 * THE DEMO ACCOUNT gets a second, stricter bucket on the same address. Its
 * credentials are published so a reviewer can sign in without registering,
 * which means they are published to everyone. See BUCKETS.demoPerIp.
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
    const address = clientAddress(request);

    const attempt = take("signIn", address);
    if (!attempt.ok) return refuse(attempt.resetAt);

    /*
     * THE DEMO ACCOUNT, if one is configured.
     *
     * Its email is the only credential this route can identify without reading
     * the body, and it can only be identified when the client volunteers it —
     * which it does, because @better-auth's client sends the email in the JSON
     * body, not the URL. So instead of parsing the body, the stricter bucket
     * is applied to EVERY sign-in from this address whenever a demo account
     * exists. That is deliberately blunt: the demo deployment is the one where
     * the credentials are public, and a visitor who is signing in as themselves
     * three times a minute is already unusual.
     */
    if (env.DEMO_USER_EMAIL && pathname.endsWith("/sign-in/email")) {
      const demo = take("demoPerIp", address);
      if (!demo.ok) return refuse(demo.resetAt);
    }
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
