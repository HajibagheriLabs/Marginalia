import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge only knows Tailwind's stock scales. Light Table replaces
 * several of them wholesale, so without this it cannot tell that
 * `rounded-control` and `rounded-lg` are the same property — it keeps both and
 * lets source order decide, which silently defeats every override.
 *
 * Registering the design system's scales here is what makes
 * `cn("rounded-lg", "rounded-control")` resolve to 4px, so a shadcn component's
 * built-in classes can actually be overridden at the call site.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      // Radius: the only five that exist.
      radius: ["sheet", "control", "panel", "dialog", "chip"],
      // Depth: the only two that exist.
      shadow: ["sheet", "overlay"],
      // Type scale.
      text: [
        "display",
        "page-title",
        "section-title",
        "body",
        "body-sm",
        "document",
        "mono-sm",
        "mono-xs",
      ],
      // Colour tokens, so text-/bg-/border- utilities dedupe correctly.
      // `text-text` is a colour and `text-body` is a size; registering each in
      // its own scale is what lets tailwind-merge tell them apart.
      color: [
        "room",
        "surface",
        "surface-raised",
        "edge",
        "edge-strong",
        "text",
        "text-muted",
        "text-faint",
        "paper",
        "paper-edge",
        "paper-text",
        "paper-text-muted",
        "ink-citrine",
        "ink-rose",
        "ink-jade",
        "ink-azure",
        "ok",
        "warn",
        "danger",
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
