import { AlertTriangle } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * What happened, and what to do about it.
 *
 * The writing rule for errors is: state the fact, give the next step, never
 * apologise. "Sorry, something went wrong" tells the reader nothing they did
 * not already know. `title` is the fact; `detail` is the next step.
 *
 * --danger is a SYSTEM STATE, not an ink, and it is spent on the icon and a
 * hairline only. A wash of red across the panel would be the loudest thing on
 * the screen, and the loudest thing on the screen is supposed to be a citation.
 */
export function ErrorState({
  title,
  detail,
  action,
  className,
}: {
  /** What happened. */
  title: string;
  /** What to do about it. */
  detail?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-start gap-2 rounded-panel border border-danger/40 bg-surface p-4",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
        <div className="flex flex-col gap-1">
          <p className="text-body font-medium text-text">{title}</p>
          {detail ? (
            <p className="text-body-sm text-text-muted">{detail}</p>
          ) : null}
        </div>
      </div>
      {action ? <div className="pl-6">{action}</div> : null}
    </div>
  );
}
