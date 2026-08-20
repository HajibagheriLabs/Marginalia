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
import { signUp } from "@/lib/auth-client";

export function SignUpForm() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const form = new FormData(event.currentTarget);
    const email = String(form.get("email"));

    const { error: signUpError } = await signUp.email({
      name: String(form.get("name")),
      email,
      password: String(form.get("password")),
      // Where the link in the verification email lands.
      callbackURL: "/",
    });

    setPending(false);

    if (signUpError) {
      setError(signUpError.message ?? "Could not create the account.");
      return;
    }

    // No session yet: verification is required before one is issued.
    setSentTo(email);
  }

  if (sentTo) {
    return (
      <>
        <AuthHeader
          title="Confirm your address"
          description={`A verification link is on its way to ${sentTo}. It expires in an hour.`}
        />
        <AuthNotice>
          No email provider is configured yet, so the link is printed to the
          server console instead. Check the terminal running the dev server.
        </AuthNotice>
        <AuthFooter>
          Already confirmed? <AuthLink href="/sign-in">Sign in</AuthLink>
        </AuthFooter>
      </>
    );
  }

  return (
    <>
      <AuthHeader
        title="Create an account"
        description="Upload documents and ask questions about them."
      />
      <AuthError message={error} />

      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <AuthField
          id="name"
          name="name"
          label="Name"
          type="text"
          autoComplete="name"
          required
        />
        <AuthField
          id="email"
          name="email"
          label="Email"
          type="email"
          autoComplete="email"
          required
        />
        <AuthField
          id="password"
          name="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          hint="At least 8 characters."
        />
        <AuthSubmit pending={pending}>
          {pending ? "Creating account…" : "Create account"}
        </AuthSubmit>
      </form>

      <AuthFooter>
        Already have an account? <AuthLink href="/sign-in">Sign in</AuthLink>
      </AuthFooter>
    </>
  );
}
