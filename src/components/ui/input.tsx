import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The text input, retuned for Light Table: a 4px control radius, a --surface-
 * raised well inside a hairline, and no ring — focus is the global 2px outline
 * (see the FOCUS block in globals.css), so it stays surface-aware and cannot be
 * deleted by a utility.
 *
 * 16px on small screens and 14px from `sm` up: anything under 16px makes iOS
 * Safari zoom the viewport on focus.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-control border border-edge-strong bg-surface-raised px-2.5 py-1 text-base text-text sm:text-body",
        "placeholder:text-text-faint",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-danger",
        "file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-body-sm file:font-medium file:text-text",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
