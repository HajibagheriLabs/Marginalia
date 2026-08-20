import { Suspense } from "react";
import type { Metadata } from "next";

import { SignInForm } from "@/components/auth/sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage() {
  // The form reads ?next and ?verified from the URL, so it needs a Suspense
  // boundary to stay statically renderable.
  return (
    <Suspense fallback={null}>
      <SignInForm />
    </Suspense>
  );
}
