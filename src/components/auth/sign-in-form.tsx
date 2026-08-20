"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import {
  AuthError,
  AuthField,
  AuthFooter,
  AuthHeader,
  AuthLink,
  AuthNotice,
  AuthSubmit,
} from "@/components/auth/auth-form";
import { signIn } from "@/lib/auth-client";

export function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();

  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [unverified, setUnverified] = useState(false);

  // Only ever a same-origin path, never an absolute URL — an open redirect
  // here would hand an attacker a credible-looking phishing link.
  const rawNext = params.get("next");
  const next = rawNext?.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/";

  const justReset = params.get("reset") === "1";

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setUnverified(false);
    setPending(true);

    const form = new FormData(event.currentTarget);

    const { error: signInError } = await signIn.email({
      email: String(form.get("email")),
      password: String(form.get("password")),
      callbackURL: next,
    });

    setPending(false);

    if (signInError) {
      // Better Auth refuses to issue a session until the address is confirmed,
      // and sends a fresh link when this happens.
      if (signInError.code === "EMAIL_NOT_VERIFIED") {
        setUnverified(true);
        return;
      }
      setError(signInError.message ?? "Email or password is incorrect.");
      return;
    }

    router.push(next);
    router.refresh();
  }

  return (
    <>
      <AuthHeader
        title="Sign in"
        description="Pick up where you left off."
      />

      {justReset ? (
        <AuthNotice>Password updated. Sign in with the new one.</AuthNotice>
      ) : null}

      {unverified ? (
        <AuthNotice>
          This address isn&apos;t confirmed yet. A new verification link has
          been sent — check the server console, since no email provider is
          configured.
        </AuthNotice>
      ) : null}

      <AuthError message={error} />

      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <AuthField
          id="email"
          name="email"
          label="Email"
          type="email"
          autoComplete="email"
          required
        />
        <div className="flex flex-col gap-1.5">
          <AuthField
            id="password"
            name="password"
            label="Password"
            type="password"
            autoComplete="current-password"
            required
          />
          <p className="text-body-sm">
            <AuthLink href="/forgot-password">Forgot your password?</AuthLink>
          </p>
        </div>
        <AuthSubmit pending={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </AuthSubmit>
      </form>

      <AuthFooter>
        No account yet? <AuthLink href="/sign-up">Create one</AuthLink>
      </AuthFooter>
    </>
  );
}
