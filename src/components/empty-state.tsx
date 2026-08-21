import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * One sentence and one action. That is the whole contract.
 *
 * An empty state that lists three things you could try is a menu, and a menu is
 * what the interface shows when it has not decided what you should do next. Say
 * the one true sentence, offer the one obvious action.
 */
export function EmptyState({
  icon: Icon,
  title,
  action,
  className,
}: {
  icon?: LucideIcon;
  /** One sentence, plain, no apology. */
  title: string;
  /** One action. Usually a Button. */
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-5 py-10 text-center",
        className,
      )}
    >
      {Icon ? (
        <Icon aria-hidden className="size-5 shrink-0 text-text-faint" />
      ) : null}
      <p className="max-w-[44ch] text-body text-text-muted">{title}</p>
      {action}
    </div>
  );
}
