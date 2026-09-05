"use client";

import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowUp, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Past this the textarea scrolls instead of growing — about eight lines. */
const MAX_HEIGHT = 200;

/** The platform never changes under us, so there is nothing to subscribe to. */
const subscribeToNothing = () => () => {};

/**
 * The send hint names a modifier key, and which key that is depends on the
 * platform — which the server cannot know. `useSyncExternalStore` is the
 * sanctioned way to say that: the server snapshot is null, so the markup
 * matches on both sides, and the real key appears on the client without a
 * hydration mismatch. The hint row reserves its height either way, so nothing
 * moves when the key arrives.
 */
function useSendKey(): string | null {
  return useSyncExternalStore(
    subscribeToNothing,
    () => (/mac|iphone|ipad/i.test(navigator.userAgent) ? "⌘↵" : "Ctrl ↵"),
    () => null,
  );
}

export interface ComposerProps {
  onSubmit: (value: string) => void;
  placeholder?: string;
  /**
   * Disabling a control without saying why is the interface refusing to
   * explain itself, so a reason is REQUIRED alongside `disabled` — the type
   * makes it impossible to disable the composer silently.
   */
  disabled?: boolean;
  disabledReason?: string;
  /**
   * An answer is being retrieved or streamed. The send button becomes a stop
   * button; the textarea stays LIVE so the next question can be typed while
   * the current answer arrives.
   */
  streaming?: boolean;
  /** Required whenever `streaming` is true. Aborts the request. */
  onStop?: () => void;
  className?: string;
  autoFocus?: boolean;
}

/**
 * The question box.
 *
 * Cmd/Ctrl+Enter sends and a bare Enter inserts a newline. That is the
 * deliberate inversion of the usual chat default: questions here are about
 * contracts and clinical guidelines, they run long, and losing a half-written
 * question to a stray Enter is worse than pressing one extra key to send.
 *
 * The textarea grows with its content up to eight lines, then scrolls. The
 * conversation pane is 400–520px wide, so an unbounded box would eat the
 * message list.
 */
export function Composer({
  onSubmit,
  placeholder = "Ask a question about these documents",
  disabled = false,
  disabledReason,
  streaming = false,
  onStop,
  className,
  autoFocus = false,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const sendKey = useSendKey();

  // Grow before paint, so the box is never briefly the wrong height.
  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  const trimmed = value.trim();
  // Sending while an answer streams would race two questions into one thread.
  // Stop first — which is why the same button does both.
  const canSend = !disabled && !streaming && trimmed.length > 0;

  function send() {
    if (!canSend) return;
    onSubmit(trimmed);
    setValue("");
  }

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div
        className={cn(
          "flex items-end gap-2 rounded-panel border border-edge bg-surface-raised p-2",
          // The focus ring belongs to the whole box, not to the bare textarea
          // inside it — the box is what looks like the control.
          "focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-text",
          disabled && "opacity-60",
        )}
      >
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          autoFocus={autoFocus}
          disabled={disabled}
          placeholder={placeholder}
          aria-label="Ask a question"
          aria-describedby={disabled && disabledReason ? "composer-reason" : undefined}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              send();
            }
          }}
          className={cn(
            "max-h-[200px] flex-1 resize-none bg-transparent px-1 py-1 text-body text-text",
            "placeholder:text-text-faint focus-visible:outline-none",
            "disabled:cursor-not-allowed",
          )}
        />

        {streaming ? (
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            onClick={onStop}
            aria-label="Stop answering"
          >
            <Square aria-hidden className="fill-current" />
          </Button>
        ) : (
          <Button
            type="button"
            size="icon-sm"
            onClick={send}
            disabled={!canSend}
            aria-label="Send question"
          >
            <ArrowUp aria-hidden />
          </Button>
        )}
      </div>

      {/* One line, always present: either the reason the box is off, or the
          keyboard hint. Reserving the row stops the composer twitching. */}
      <p
        id={disabled && disabledReason ? "composer-reason" : undefined}
        className="min-h-[16px] px-1 text-[11px] leading-4 text-text-faint"
      >
        {disabled && disabledReason ? (
          disabledReason
        ) : streaming ? (
          "Answering. Press stop to cancel."
        ) : sendKey ? (
          <>
            <span className="num">{sendKey}</span> to send
          </>
        ) : null}
      </p>
    </div>
  );
}
