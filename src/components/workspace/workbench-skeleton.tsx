import { PaperSheetSkeleton, Skeleton, SkeletonText } from "@/components/skeleton";
import { CONVERSATION_DEFAULT_WIDTH } from "@/lib/workspace-prefs";

/**
 * THE WORKSPACE, DRAWN BEFORE IT HAS ANYTHING TO SAY.
 *
 * Every measurement here is copied from `Workbench`, deliberately and by hand:
 * the same `flex-1` reading pane, the same 1px separator, the same conversation
 * column at the default width, the same bottom bar below 1024px. A skeleton
 * that is merely "about the right shape" moves the page when the real content
 * lands, and the entire reason for drawing one is to stop that.
 *
 * The width is the DEFAULT rather than the user's remembered one. Reading the
 * cookie here would be possible and is not worth it: this renders for a few
 * hundred milliseconds, and a skeleton that has to await anything is a skeleton
 * that arrives late.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ONE `role="status"`, NOT SEVEN
 *
 * The sub-skeletons it composes are `aria-hidden`, and this wrapper carries the
 * single live region. A screen reader should hear "Loading the workspace" once,
 * not "Loading document, loading conversation, loading documents" as three
 * separate announcements for one navigation.
 *
 * NOTHING PULSES. The motion budget is spent on streaming text, the citation
 * wipe, and the rail marks fading in. A shimmering placeholder would be a
 * fourth animation, and it would be the one competing with an answer being
 * streamed two panes over.
 */
export function WorkbenchSkeleton() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Loading the workspace"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* ---- READING PANE ------------------------------------------------ */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* The viewer toolbar: page controls, zoom, search, download. */}
          <div className="flex h-10 shrink-0 items-center gap-3 border-b border-edge px-3">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-10" />
            <div className="flex-1" />
            <Skeleton className="h-4 w-24" />
          </div>

          <div className="flex min-h-0 flex-1 items-start justify-center overflow-hidden bg-room p-6">
            <PaperSheetSkeleton />
          </div>
        </div>

        {/* The separator, drawn so the panes do not shift sideways when the
            real one (which is focusable and draggable) replaces it. */}
        <div aria-hidden className="hidden w-px shrink-0 bg-edge lg:block" />

        {/* ---- CONVERSATION PANE ------------------------------------------- */}
        <div
          className="flex min-h-0 w-full flex-col lg:w-[var(--conversation-skeleton-width)] lg:shrink-0"
          style={
            {
              "--conversation-skeleton-width": `${CONVERSATION_DEFAULT_WIDTH}px`,
            } as React.CSSProperties
          }
        >
          {/* The pane header: title and scope selector. */}
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-edge px-3">
            <Skeleton className="h-4 w-32" />
          </div>
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-edge px-3">
            <Skeleton className="h-3 w-24" />
          </div>

          {/* Two turns: a short question, a longer answer. */}
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-hidden p-4">
            <div className="flex justify-end">
              <Skeleton className="h-8 w-[70%] rounded-panel" />
            </div>
            <SkeletonText lines={5} className="measure" />
            <div className="flex justify-end">
              <Skeleton className="h-8 w-[55%] rounded-panel" />
            </div>
            <SkeletonText lines={3} className="measure" />
          </div>

          {/* The composer, at its resting height. */}
          <div className="shrink-0 border-t border-edge p-3">
            <Skeleton className="h-16 w-full rounded-panel" />
          </div>
        </div>
      </div>

      {/* Below 1024px the panes are tabs and this bar is always present. */}
      <div
        aria-hidden
        className="flex shrink-0 flex-col gap-1.5 border-t border-edge bg-surface p-1.5 lg:hidden"
      >
        <div className="flex items-center gap-1">
          <Skeleton className="h-7 flex-1" />
          <Skeleton className="h-7 flex-1" />
        </div>
      </div>
    </div>
  );
}

/**
 * The library rail while its two lists are being read.
 *
 * Rendered as the Suspense fallback in the workspace layout, so the shell —
 * the rail's own frame, the main column, the page beneath — paints immediately
 * instead of waiting on two database queries.
 */
export function RailSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading the library"
      className="flex min-h-0 flex-1 flex-col gap-4 p-3"
    >
      <Skeleton className="h-8 w-full rounded-control" />

      <div className="flex flex-col gap-2">
        <Skeleton className="h-2.5 w-20" />
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex flex-col gap-1.5 px-2 py-1.5">
            <Skeleton className="h-3 w-[80%]" />
            <Skeleton className="ml-3.5 h-2.5 w-[40%]" />
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        <Skeleton className="h-2.5 w-24" />
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="mx-2 h-3 w-[70%]" />
        ))}
      </div>
    </div>
  );
}
