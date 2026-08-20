"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import {
  AuthError,
  AuthField,
  AuthFooter,
  AuthHeader,
  AuthLink,
  AuthSubmit,
} from "@/components/auth/auth-form";
import { resetPassword } from "@/lib/auth-client";

export function ResetPasswordForm() {
  const router = useRouter();
  const params = useSearchParams();

  const token = params.get("token");
  // Better Auth redirects here with ?error=INVALID_TOKEN when the link has
  // already been used or has expired.
  const linkError = params.get("error");

  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const form = new FormData(event.currentTarget);
    const password = String(form.get("password"));

    if (password !== String(form.get("confirm"))) {
      setError("The two passwords don't match.");
      return;
    }

    setPending(true);
    const { error: resetError } = await resetPassword({
      newPassword: password,
      token: token ?? "",
    });
    setPending(false);

    if (resetError) {
      setError(resetError.message ?? "Could not set the new password.");
      return;
    }

    // Every other session was revoked, so signing in again is required.
    router.push("/sign-in?reset=1");
  }

  if (!token || linkError) {
    return (
      <>
        <AuthHeader
          title="This link has expired"
          description="Reset links are good for one hour and can be used once."
        />
        <AuthFooter>
          <AuthLink href="/forgot-password">Request a new one</AuthLink>
        </AuthFooter>
      </>
    );
  }

  return (
    <>
      <AuthHeader
        title="Choose a new password"
        description="You'll be signed out everywhere else."
      />
      <AuthError message={error} />

      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <AuthField
          id="password"
          name="password"
          label="New password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          hint="At least 8 characters."
        />
        <AuthField
          id="confirm"
          name="confirm"
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
        />
        <AuthSubmit pending={pending}>
          {pending ? "Saving…" : "Set new password"}
        </AuthSubmit>
      </form>

      <AuthFooter>
        <AuthLink href="/sign-in">Back to sign in</AuthLink>
      </AuthFooter>
    </>
  );
}
