"use client";

import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Dialogs and drawers — the second and last thing in the application that is
 * lifted off the surface. `--shadow-overlay` appears here and in the dropdown
 * and tooltip; `--shadow-sheet` appears on the paper sheet. There is no third
 * shadow anywhere.
 *
 * Nothing animates in or out. The motion budget is spent on streaming text, the
 * 220ms citation wipe, and Evidence Rail marks; an overlay that fades is
 * decoration, and decoration is what this design system does not buy.
 */

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        // A plain scrim. The room dims; it does not blur or tint.
        "fixed inset-0 z-50 bg-room/70",
        className,
      )}
      {...props}
    />
  );
}

/**
 * RESTORE FOCUS TO WHATEVER OPENED THE DIALOG.
 *
 * Radix returns focus to its `DialogTrigger` on close. Every dialog in this
 * application is CONTROLLED — opened by a state change rather than by a
 * trigger, because the limit dialog opens in response to a failed request and
 * has no trigger at all — so `triggerRef` is null and focus falls to `<body>`.
 * Measured, not assumed.
 *
 * For a keyboard or screen-reader user that is the difference between closing a
 * confirmation and carrying on, and closing a confirmation and being returned
 * to the top of the document with everything to tab through again.
 *
 * So the element that had focus when the dialog opened is captured on mount and
 * focused on close. If it has since been removed from the document — a menu
 * item inside a dropdown that closed behind the dialog — `focus()` on a
 * detached node does nothing and the behaviour is what it already was.
 *
 * A caller's own `onCloseAutoFocus` still runs and still wins: it is called
 * first, and if it calls `preventDefault` this leaves focus alone.
 */
function useReturnFocus(
  onCloseAutoFocus?: (event: Event) => void,
): Pick<
  React.ComponentProps<typeof DialogPrimitive.Content>,
  "onCloseAutoFocus"
> {
  const opener = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    opener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    return () => {
      opener.current = null;
    };
  }, []);

  return {
    onCloseAutoFocus: (event) => {
      onCloseAutoFocus?.(event);
      if (event.defaultPrevented) return;

      const target = opener.current;
      if (!target || !target.isConnected) return;

      // Take over from Radix, which would otherwise focus nothing.
      event.preventDefault();
      target.focus();
    },
  };
}

function DialogContent({
  className,
  children,
  showClose = true,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showClose?: boolean;
}) {
  const returnFocus = useReturnFocus(onCloseAutoFocus);

  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex w-[calc(100%-32px)] max-w-[440px] -translate-x-1/2 -translate-y-1/2 flex-col gap-4",
          "rounded-dialog border border-edge bg-surface p-5 shadow-overlay",
          className,
        )}
        {...props}
        // After `props`, so a caller cannot accidentally drop the restoration
        // by passing its own handler — theirs is composed in, not replaced.
        onCloseAutoFocus={returnFocus.onCloseAutoFocus}
      >
        {children}
        {showClose ? (
          <DialogPrimitive.Close
            aria-label="Close"
            className="absolute top-4 right-4 rounded-control p-1 text-text-faint hover:text-text"
          >
            <X aria-hidden className="size-4" />
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

/**
 * A drawer anchored to the left edge, full height. Below 1024px the library
 * rail becomes this. It is a Dialog rather than a bespoke panel so it inherits
 * the focus trap, the scroll lock, and Escape-to-close for free.
 *
 * Square against the screen edge, 12px on the inner corners: the panel is
 * sliding out from off-screen, so only the edge you can see gets a radius.
 */
function DrawerContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="drawer-content"
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-[280px] max-w-[85vw] flex-col",
          "rounded-r-dialog border-r border-edge bg-surface shadow-overlay",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-1.5 pr-6", className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex flex-row justify-end gap-2", className)}
      {...props}
    />
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-section-title text-text", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-body-sm text-text-muted", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  DrawerContent,
};
