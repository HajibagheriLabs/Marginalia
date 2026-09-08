"use client";

import { RouteError } from "@/components/route-error";

/**
 * The workspace. Replaces the two panes and leaves the library rail standing,
 * because the rail is rendered by the layout and the layout did not fail — so a
 * reader keeps their bearings and can navigate to another document instead of
 * being dropped onto a blank page.
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
      title="This part of the workspace could not be loaded."
      detail="Your documents are safe. Try again, or open another document from the library."
      error={error}
      reset={reset}
    />
  );
}
