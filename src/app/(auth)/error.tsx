"use client";

import { RouteError } from "@/components/route-error";

/**
 * Sign in, sign up, and the two password routes. Deliberately says nothing
 * about accounts: an error page that distinguishes 'no such account' from
 * 'something broke' is an oracle for whether an address is registered.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteError
      title="This page could not be loaded."
      detail="Try again. If it keeps happening, reload the page to start a fresh session."
      error={error}
      reset={reset}
    />
  );
}
