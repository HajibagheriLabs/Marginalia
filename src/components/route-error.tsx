"use client";

import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/error-state";

/**
 * THE BODY OF EVERY `error.tsx` IN THE APPLICATION.
 *
 * One implementation, because the shape of the answer is the same everywhere —
 * say what broke, offer the thing that fixes it — and only the sentence
 * changes. Four copies of this would be four places for the retry button to
 * drift.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THE ERROR'S OWN MESSAGE IS NOT SHOWN
 *
 * In production, React and Next replace a server error's message with a generic
 * string before it ever reaches the browser, and keep the real one in the
 * server log under `digest`. Rendering `error.message` would therefore print
 * "An error occurred in the Server Components render" to a user — worse than
 * useless, because it reads like an explanation and is not one.
 *
 * So each route passes a sentence written for the person reading it, and the
 * digest is printed as a reference they can quote. In development the message
 * IS the real one, so it is shown there.
 *
 * `reset()` re-renders the segment. That is the right first action for the
 * failures that actually happen here — a dropped database connection, a
 * transient upstream error — and it costs nothing when it does not work.
 */
export function RouteError({
  title,
  detail,
  error,
  reset,
}: {
  /** What broke, in the reader's terms. */
  title: string;
  /** What to do about it. */
  detail: string;
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The browser console is the only place a client-side error is visible; the
    // server-side ones are already logged with their digest.
    console.error("[route]", error);
  }, [error]);

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <ErrorState
        className="w-full max-w-[520px]"
        title={title}
        detail={detail}
        action={
          <div className="flex flex-col gap-2">
            <Button size="sm" variant="outline" onClick={reset}>
              Try again
            </Button>
            {error.digest ? (
              <p className="num text-mono-xs text-text-faint">
                Reference: {error.digest}
              </p>
            ) : null}
            {process.env.NODE_ENV === "development" && error.message ? (
              <p className="max-w-[60ch] font-mono text-mono-xs break-words text-text-faint">
                {error.message}
              </p>
            ) : null}
          </div>
        }
      />
    </div>
  );
}
