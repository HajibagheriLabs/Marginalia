"use client";

import { useState } from "react";

import {
  AuthError,
  AuthField,
  AuthFooter,
  AuthHeader,
  AuthLink,
  AuthNotice,
  AuthSubmit,
} from "@/components/auth/auth-form";
import { requestPasswordReset } from "@/lib/auth-client";

export function ForgotPasswordForm() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const form = new FormData(event.currentTarget);

    const { error: resetError } = await requestPasswordReset({
      email: String(form.get("email")),
      // Where the link in the email lands; Better Auth appends the token.
      redirectTo: "/reset-password",
    });

    setPending(false);

    // Only a transport failure surfaces here. An unknown address deliberately
    // returns success — see the confirmation copy below.
    if (resetError) {
      setError(resetError.message ?? "Could not send the reset link.");
      return;
    }

    setSent(true);
  }

  if (sent) {
    return (
      <>
        <AuthHeader
          title="Check your email"
          description="If that address has an account, a reset link is on its way. It expires in an hour."
        />
        <AuthNotice>
          No email provider is configured yet, so the link is printed to the
          server console instead.
        </AuthNotice>
        <AuthFooter>
          <AuthLink href="/sign-in">Back to sign in</AuthLink>
        </AuthFooter>
      </>
    );
  }

  return (
    <>
      <AuthHeader
        title="Reset your password"
        description="Enter your address and we'll send a link to set a new password."
      />
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
        <AuthSubmit pending={pending}>
          {pending ? "Sending…" : "Send reset link"}
        </AuthSubmit>
      </form>

      <AuthFooter>
        Remembered it? <AuthLink href="/sign-in">Sign in</AuthLink>
      </AuthFooter>
    </>
  );
}
