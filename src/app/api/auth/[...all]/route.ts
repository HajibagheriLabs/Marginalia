import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@/lib/auth";

/**
 * Every Better Auth endpoint: sign-up, sign-in, sign-out, email verification,
 * password reset, and the OAuth callbacks if a provider is ever added.
 */
export const { GET, POST } = toNextJsHandler(auth.handler);
