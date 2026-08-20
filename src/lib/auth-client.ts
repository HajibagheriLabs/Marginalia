"use client";

import { createAuthClient } from "better-auth/react";

import { publicEnv } from "./env.public";

/**
 * Browser-side auth. Only the four flows this app has are re-exported, so a
 * page can't reach for something the server isn't configured to do.
 */
export const authClient = createAuthClient({
  baseURL: publicEnv.NEXT_PUBLIC_APP_URL,
});

export const { signIn, signUp, signOut, useSession } = authClient;

/** Sends the "choose a new password" email. */
export const requestPasswordReset = authClient.requestPasswordReset;

/** Consumes the token from that email and sets the new password. */
export const resetPassword = authClient.resetPassword;
