import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";

import { db, schema } from "@/db";

import { env } from "./env";
import {
  email,
  passwordResetEmail,
  verificationEmail,
} from "./email";

/**
 * Better Auth, email + password.
 *
 * There are no organizations and no roles. One user owns their documents, and
 * ownership is the entire authorization model — see src/lib/auth-server.ts for
 * where that is enforced.
 *
 * Two configuration details are load-bearing:
 *
 *  - `usePlural: true`, because the Drizzle tables are named `users`,
 *    `sessions`, `accounts`, `verifications`. Drop it and every query looks up
 *    a table called `user` and fails at runtime.
 *  - `advanced.database.generateId: false`, because the id columns are
 *    `uuid ... DEFAULT gen_random_uuid()`. Without it Better Auth generates its
 *    own string ids and Postgres rejects them as invalid uuids.
 */
export const auth = betterAuth({
  appName: "Marginalia",
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [env.BETTER_AUTH_URL],

  database: drizzleAdapter(db, {
    provider: "pg",
    usePlural: true,
    schema,
  }),

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    // A session is not issued until the address is confirmed. Sign-in attempts
    // by an unverified user are rejected and trigger a fresh verification mail.
    requireEmailVerification: true,
    // Sign-up therefore cannot produce a session either.
    autoSignIn: false,
    // Any other device holding a session loses it when the password changes.
    revokeSessionsOnPasswordReset: true,
    async sendResetPassword({ user, url }) {
      await email.send({ to: user.email, ...passwordResetEmail(url) });
    },
  },

  emailVerification: {
    sendOnSignUp: true,
    // Asking someone to sign in again immediately after they just proved they
    // own the address is friction with no security benefit.
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60,
    async sendVerificationEmail({ user, url }) {
      await email.send({ to: user.email, ...verificationEmail(url) });
    },
  },

  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // refresh the expiry at most once a day
  },

  advanced: {
    // The database mints uuids; Better Auth must not.
    database: { generateId: false },
    // Secure cookies are automatic in production; this makes it explicit.
    useSecureCookies: env.NODE_ENV === "production",
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    },
  },

  /**
   * SEAM — GitHub OAuth.
   *
   * The `accounts` table already carries everything a provider needs
   * (`issuer`, `account_id`, `provider_id`, the token columns), so adding
   * GitHub is configuration, not a migration:
   *
   *   socialProviders: {
   *     github: {
   *       clientId: env.GITHUB_CLIENT_ID,
   *       clientSecret: env.GITHUB_CLIENT_SECRET,
   *     },
   *   },
   *
   * Then add GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET to src/lib/env.ts and
   * .env.example, register the callback URL
   * `${BETTER_AUTH_URL}/api/auth/callback/github` in the GitHub OAuth app, and
   * render a sign-in button that calls
   * `authClient.signIn.social({ provider: "github" })`.
   *
   * Note that GitHub can return a verified address, in which case that user
   * skips the email verification step above.
   */

  // Must be last: lets Server Actions set the session cookie.
  plugins: [nextCookies()],
});

export type Session = typeof auth.$Infer.Session;
export type SessionUser = Session["user"];
