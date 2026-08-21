import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * The button, retuned for Light Table.
 *
 * Three deliberate departures from stock shadcn/ui, each enforcing a rule that
 * would otherwise have to be re-fought at every call site:
 *
 *  1. RADIUS. Stock uses `rounded-lg` and a `min(var(--radius-md), 10px)`
 *     ladder. The system has exactly five radii; a control is 4px.
 *  2. FOCUS. Stock sets `outline-none` and paints a 3px translucent ring.
 *     The system specifies a 2px SURFACE-AWARE outline — `--text` in the room,
 *     `--paper-text` on the sheet — and it is never removed. Deleting
 *     `outline-none` lets the global rule in globals.css do that job, which is
 *     also what makes a button work when it sits on the paper sheet.
 *  3. MOTION. Stock transitions every property and nudges 1px on press.
 *     Streaming text, the citation wipe, and Evidence Rail marks are the only
 *     motion in this application, so hover and press are instant state changes.
 *
 * Every variant is monochrome. `destructive` is the single exception and it is
 * a SYSTEM STATE, not an ink — colour here would otherwise mean citation.
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center gap-1.5 rounded-control border border-transparent bg-clip-padding text-body font-medium whitespace-nowrap select-none disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-danger [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        /** The emphatic action: --text fill, --room label. */
        default: "bg-text text-room hover:opacity-90",
        outline:
          "border-edge-strong bg-surface-raised text-text hover:bg-surface aria-expanded:bg-surface",
        secondary:
          "bg-surface-raised text-text hover:bg-surface aria-expanded:bg-surface",
        ghost:
          "text-text-muted hover:bg-surface-raised hover:text-text aria-expanded:bg-surface-raised aria-expanded:text-text",
        destructive:
          "border-danger/40 bg-transparent text-danger hover:bg-danger/10",
        /** Links carry their affordance in the underline, never in colour. */
        link: "text-text underline underline-offset-4 hover:text-text-muted",
      },
      size: {
        // Heights sit on the 8-grid: 24 / 28 / 32 / 36.
        default: "h-8 px-2.5",
        xs: "h-6 gap-1 px-2 text-mono-xs [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 px-2.5 text-body-sm [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 px-3",
        icon: "size-8",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
