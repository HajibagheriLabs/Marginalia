"use client";

import { RouteError } from "@/components/route-error";

/**
 * The public pages. Renders inside the root layout, so the fonts and the theme
 * are present and this can use the design system normally.
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
      detail="The connection may have dropped. Try again, or open the demo from the home page."
      error={error}
      reset={reset}
    />
  );
}
