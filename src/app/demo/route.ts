import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { conversations } from "@/db/schema";
import { auth } from "@/lib/auth";
import { DEMO_USER_EMAIL, DEMO_USER_ID } from "@/lib/demo";
import { env } from "@/lib/env";
import { clientAddress, take } from "@/lib/rate-limit";

/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ /demo — one click from a cold visitor to a populated workspace.          │
 * │                                                                          │
 * │ Signs the visitor in as the shared demo account and redirects them into  │
 * │ a conversation that already has answers in it, so the Evidence Rail is   │
 * │ marked up before they type anything. No form, no password to copy, no    │
 * │ sign-up.                                                                 │
 * │                                                                          │
 * │ THE PASSWORD IS PUBLISHED, NOT SECRET. It is in .env.example and in the  │
 * │ README, and this route hands out a session for it to anyone who asks.    │
 * │ That is the point of a demo account, and it is only safe because of what │
 * │ the account CANNOT do — see DEMO_RESTRICTIONS: no uploads, no deletes, a │
 * │ lower daily question cap. Everything a visitor can do to this workspace  │
 * │ is undone by `npm run db:reset-demo`.                                    │
 * │                                                                          │
 * │ It still goes through the REAL sign-in path. `auth.api.signInEmail`      │
 * │ verifies the password hash and mints a session exactly as the sign-in    │
 * │ form does; there is no back door that issues a cookie without checking a │
 * │ credential. If the seeded account is missing or its password no longer   │
 * │ matches, this fails and says so rather than letting somebody in.         │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

/** Sessions are minted here and the demo password is verified here. Node only. */
export const runtime = "nodejs";

/**
 * Never cached, in either direction.
 *
 * The response carries a `Set-Cookie` for a fresh session. A cached copy would
 * hand the next visitor the previous visitor's session cookie — which, on a
 * shared account, is not a data leak but IS a subtle bug: two people would be
 * writing into one session's rate-limit bucket and one browser's history.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  /*
   * RATE LIMITED PER ADDRESS, and this is the one route where that is the only
   * option that means anything. Every visitor here is the same user, so a
   * per-user bucket would be one bucket for the entire internet and the first
   * enthusiastic visitor would close the door behind them.
   *
   * `demoPerIp` is the stricter of the two sign-in buckets — capacity 3,
   * refilling 3/minute. Enough to click the button, reload, and share the link
   * with the person next to you; not enough to mint sessions in a loop.
   */
  const address = clientAddress(request);
  const rate = take("demoPerIp", address);

  if (!rate.ok) {
    const seconds = Math.max(
      1,
      Math.ceil((rate.resetAt.getTime() - Date.now()) / 1000),
    );
    return NextResponse.json(
      {
        error: `Too many demo sign-ins from this address. Try again in ${seconds} seconds.`,
      },
      { status: 429, headers: { "retry-after": String(seconds) } },
    );
  }

  const password = env.DEMO_USER_PASSWORD;
  if (!password) {
    // A deployment that never ran the seed. Say which command fixes it rather
    // than returning a bare 500 — this is the most likely first-run failure.
    console.error("[demo] DEMO_USER_PASSWORD is not set");
    return NextResponse.json(
      {
        error:
          "The demo workspace is not configured on this deployment. Set DEMO_USER_PASSWORD and run `npm run db:seed`.",
      },
      { status: 503 },
    );
  }

  let signedIn;
  try {
    // The real path. Verifies the hash, mints the session, sets the cookie.
    signedIn = await auth.api.signInEmail({
      body: { email: DEMO_USER_EMAIL, password },
      // Asking for the raw Response is what lets the `Set-Cookie` it produced
      // be carried onto the redirect below. Without it the session is created
      // and the browser never receives it.
      returnHeaders: true,
    });
  } catch (error) {
    console.error("[demo] sign-in failed", error);
    return NextResponse.json(
      {
        error:
          "The demo account could not be signed in. It may not be seeded yet — run `npm run db:seed`.",
      },
      { status: 503 },
    );
  }

  /*
   * WHERE TO LAND THEM.
   *
   * The most recently updated seeded conversation, which is the one the seed
   * wrote last and therefore the top of the rail. Landing on /app instead would
   * show an empty composer and none of the evidence — the visitor would have to
   * find the populated thread themselves, which is exactly the friction this
   * route exists to remove.
   *
   * If the demo has no conversations (an unseeded deployment), /app is the
   * honest fallback: an empty workspace rather than a 404.
   */
  const [thread] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.userId, DEMO_USER_ID))
    .orderBy(desc(conversations.updatedAt))
    .limit(1);

  const destination = thread
    ? `/app/conversations/${thread.id}`
    : "/app";

  const response = NextResponse.redirect(new URL(destination, request.url), {
    // 303: this was a GET that produced a session as a side effect, and the
    // browser must follow with a plain GET rather than replaying anything.
    status: 303,
  });

  // Carry every cookie Better Auth set onto the redirect.
  const setCookie = signedIn.headers?.getSetCookie?.() ?? [];
  for (const cookie of setCookie) {
    response.headers.append("set-cookie", cookie);
  }

  if (setCookie.length === 0) {
    // Sign-in succeeded but produced no cookie — the visitor would land on the
    // workspace and be bounced straight back to /sign-in with no explanation.
    console.error("[demo] sign-in returned no session cookie");
    return NextResponse.json(
      { error: "The demo session could not be started. Try again." },
      { status: 503 },
    );
  }

  return response;
}
