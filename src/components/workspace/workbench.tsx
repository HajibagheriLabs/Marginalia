"use client";

import { useCallback, useRef, useState } from "react";
import type { CSSProperties } from "react";

import {
  CONVERSATION_MAX_WIDTH,
  CONVERSATION_MIN_WIDTH,
  CONVERSATION_WIDTH_COOKIE,
  clampConversationWidth,
  writePrefCookie,
} from "@/lib/workspace-prefs";
import { cn } from "@/lib/utils";

type Tab = "document" | "chat";

/**
 * The two-pane workbench: the reading pane and the conversation pane, with a
 * draggable separator between them.
 *
 * BREAKPOINT BEHAVIOUR. Below 1024px the two panes become two tabs with a
 * persistent bottom bar. Both panes are always RENDERED and the inactive one is
 * hidden with a CSS class, rather than being switched on a JavaScript media
 * query. That matters for two reasons: a media query read during render is
 * wrong on the server and corrects itself with a visible flash, and unmounting
 * the reading pane would throw away its scroll position every time you glanced
 * at the conversation. Above 1024px the tab state is simply ignored by CSS.
 *
 * The width is a CSS custom property, not an inline `width`, so it can be
 * applied at `lg` and above only — the pane is full width when it is a tab.
 */
export function Workbench({
  reading,
  conversation,
  initialConversationWidth,
}: {
  reading: React.ReactNode;
  conversation: React.ReactNode;
  /** Read from a cookie on the server, so the first paint is already correct. */
  initialConversationWidth: number;
}) {
  const [tab, setTab] = useState<Tab>("document");
  const [width, setWidth] = useState(initialConversationWidth);

  // The pointer handlers need the current width without re-subscribing.
  const widthRef = useRef(width);
  const applyWidth = useCallback((next: number) => {
    const clamped = clampConversationWidth(next);
    widthRef.current = clamped;
    setWidth(clamped);
  }, []);

  const persist = useCallback(() => {
    writePrefCookie(CONVERSATION_WIDTH_COOKIE, String(widthRef.current));
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Only a primary-button drag resizes.
      if (event.button !== 0) return;
      event.preventDefault();

      const startX = event.clientX;
      const startWidth = widthRef.current;
      const separator = event.currentTarget;
      separator.setPointerCapture(event.pointerId);

      const onMove = (moveEvent: PointerEvent) => {
        // Dragging left widens the conversation pane, which is why the delta
        // is subtracted: the pane is anchored to the right edge.
        applyWidth(startWidth - (moveEvent.clientX - startX));
      };

      const onUp = () => {
        separator.removeEventListener("pointermove", onMove);
        separator.removeEventListener("pointerup", onUp);
        separator.removeEventListener("pointercancel", onUp);
        persist();
      };

      separator.addEventListener("pointermove", onMove);
      separator.addEventListener("pointerup", onUp);
      separator.addEventListener("pointercancel", onUp);
    },
    [applyWidth, persist],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // A separator that can only be dragged is a separator half the people
      // using this application cannot move.
      const step = event.shiftKey ? 40 : 8;
      if (event.key === "ArrowLeft") applyWidth(widthRef.current + step);
      else if (event.key === "ArrowRight") applyWidth(widthRef.current - step);
      else if (event.key === "Home") applyWidth(CONVERSATION_MAX_WIDTH);
      else if (event.key === "End") applyWidth(CONVERSATION_MIN_WIDTH);
      else return;

      event.preventDefault();
      persist();
    },
    [applyWidth, persist],
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      style={{ "--conversation-width": `${width}px` } as CSSProperties}
    >
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section
          aria-label="Document"
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col",
            tab === "document" ? "" : "max-lg:hidden",
          )}
        >
          {reading}
        </section>

        {/* The separator IS the hairline between the panes. The wider hit area
            is a transparent overlay so the visible line stays 1px. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the conversation pane"
          aria-valuenow={width}
          aria-valuemin={CONVERSATION_MIN_WIDTH}
          aria-valuemax={CONVERSATION_MAX_WIDTH}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onKeyDown={onKeyDown}
          className="relative hidden w-px shrink-0 cursor-col-resize bg-edge hover:bg-edge-strong lg:block"
        >
          <span aria-hidden className="absolute inset-y-0 -left-1 -right-1" />
        </div>

        <aside
          aria-label="Conversation"
          className={cn(
            "flex min-h-0 w-full flex-col lg:w-[var(--conversation-width)] lg:shrink-0",
            // The hairline above only exists at lg; below it the panes are tabs
            // and share the full width, so the conversation needs its own top
            // edge against the bottom bar.
            tab === "chat" ? "" : "max-lg:hidden",
          )}
        >
          {conversation}
        </aside>
      </div>

      {/* Below 1024px: the persistent bottom bar. The active citation will live
          here next to the tabs, which is why it is a bar and not just a pair of
          buttons. */}
      <nav
        aria-label="Panes"
        className="flex shrink-0 items-center gap-1 border-t border-edge bg-surface p-1.5 lg:hidden"
      >
        <TabButton
          active={tab === "document"}
          onClick={() => setTab("document")}
        >
          Document
        </TabButton>
        <TabButton active={tab === "chat"} onClick={() => setTab("chat")}>
          Chat
        </TabButton>
      </nav>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "h-8 flex-1 rounded-control text-body font-medium",
        active ? "bg-surface-raised text-text" : "text-text-muted",
      )}
    >
      {children}
    </button>
  );
}
