import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THIS FILE IS NOT A SECURITY BOUNDARY.                                    │
 * │                                                                          │
 * │ It exists for REDIRECT UX ONLY: send a signed-out visitor to /sign-in    │
 * │ instead of letting them load a workspace shell that will fail anyway,    │
 * │ and bounce a signed-in visitor off the auth pages.                       │
 * │                                                                          │
 * │ It checks only whether a session COOKIE IS PRESENT. It does not validate │
 * │ the session, does not read the database, and does not know who the user  │
 * │ is. A forged or expired cookie sails straight through.                   │
 * │                                                                          │
 * │ Every page, Server Action, and route handler re-checks authentication    │
 * │ AND ownership server-side via requireUser / requireDocumentAccess /      │
 * │ requireConversationAccess in src/lib/auth-server.ts. That is where       │
 * │ access is actually decided. If this file were deleted tomorrow, the app  │
 * │ would be less pleasant and exactly as secure.                            │
 * │                                                                          │
 * │ Next.js makes the same point: a matcher change, or moving a Server       │
 * │ Function to another route, silently removes proxy coverage. Authorization│
 * │ that lives only here is authorization that disappears during a refactor. │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

/** Auth pages a signed-in user has no reason to see. */
const AUTH_ROUTES = [
  "/sign-in",
  "/sign-up",
  "/forgot-password",
  "/reset-password",
];

/** Reachable signed out. Everything else redirects to /sign-in. */
const PUBLIC_ROUTES = ["/", ...AUTH_ROUTES];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Presence only — deliberately not validated. See the banner above.
  const hasSessionCookie = Boolean(getSessionCookie(request));

  const isAuthRoute = AUTH_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );

  if (hasSessionCookie && isAuthRoute) {
    return NextResponse.redirect(new URL("/app", request.url));
  }

  const isPublic = PUBLIC_ROUTES.some(
    (route) =>
      pathname === route || (route !== "/" && pathname.startsWith(`${route}/`)),
  );

  if (!hasSessionCookie && !isPublic) {
    const signIn = new URL("/sign-in", request.url);
    // Come back here once they're signed in.
    signIn.searchParams.set("next", pathname + request.nextUrl.search);
    return NextResponse.redirect(signIn);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Everything except API routes, Next's internals, and static assets.
    //
    // ALL of /api is excluded, not just /api/auth. An API route answers with a
    // status code; redirecting an unauthenticated POST to /sign-in would hand
    // the caller a 307 and a page of HTML instead of a 401 it can act on. Those
    // routes read the session themselves — see src/app/api/blob/upload/route.ts.
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)",
  ],
};
