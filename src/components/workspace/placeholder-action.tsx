"use client";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";

/**
 * SCAFFOLDING — DELETE AS EACH FEATURE LANDS.
 *
 * A control that exists in the shell but has nothing behind it yet. Rather than
 * rendering a dead button or a disabled one with no explanation, it says what
 * is missing and when it arrives. A button that does nothing and says nothing
 * is the one thing worse than a button that isn't there.
 */
export function PlaceholderAction({
  children,
  note,
  ...props
}: React.ComponentProps<typeof Button> & { note: string }) {
  return (
    <Button
      {...props}
      onClick={() => toast(note, { description: "Nothing was changed." })}
    >
      {children}
    </Button>
  );
}
