"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import { Button } from "@/components/ui/button";

/**
 * Switches the room between dark and light. The paper sheet does not change —
 * that is the point of the invariant PAPER block.
 *
 * Which label shows is decided in CSS off the theme class on <html>, not from
 * React state. next-themes sets that class before first paint, so the button
 * renders correctly on the server and never has a "mounted" flash.
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => setTheme(resolvedTheme === "light" ? "dark" : "light")}
      aria-label="Switch between the dark and light room"
    >
      <Sun aria-hidden className="hidden dark:block" />
      <Moon aria-hidden className="block dark:hidden" />
      <span className="hidden dark:inline">Light room</span>
      <span className="inline dark:hidden">Dark room</span>
    </Button>
  );
}
