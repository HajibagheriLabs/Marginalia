import { cn } from "@/lib/utils";

/**
 * Loading placeholders.
 *
 * These do NOT shimmer, and that is a rule rather than an omission. The motion
 * budget in this design system is spent on three things — streaming text, the
 * 220ms citation wipe, and Evidence Rail marks fading in — and a pulsing grey
 * block is not one of them. A quiet block at --surface-raised says "content is
 * coming" without a second animation competing with the answer being streamed
 * two panes over.
 */
export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      aria-hidden
      className={cn("rounded-control bg-surface-raised", className)}
      {...props}
    />
  );
}

/** A stack of lines with a short last line, the way a paragraph ends. */
export function SkeletonText({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          className={cn("h-3", index === lines - 1 ? "w-[55%]" : "w-full")}
        />
      ))}
    </div>
  );
}

/** The library rail while the document list loads. */
export function DocumentListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-1" aria-label="Loading documents" role="status">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex flex-col gap-1.5 px-2 py-1.5">
          <Skeleton className="h-3 w-[80%]" />
          <Skeleton className="ml-3.5 h-2.5 w-[40%]" />
        </div>
      ))}
    </div>
  );
}

/**
 * The reading pane while a document loads. The sheet itself is drawn — its
 * shadow and its warm white are part of the layout, not part of the content —
 * and only the text inside it is a placeholder.
 */
export function PaperSheetSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading document"
      className="paper-sheet mx-auto w-full max-w-[720px] px-6 py-10 sm:px-12 sm:py-14"
    >
      <div className="flex flex-col gap-6">
        <div className="h-3 w-[30%] rounded-control bg-paper-edge" />
        <div className="h-5 w-[55%] rounded-control bg-paper-edge" />
        {Array.from({ length: 3 }, (_, block) => (
          <div key={block} className="flex flex-col gap-2.5">
            {Array.from({ length: 4 }, (_, line) => (
              <div
                key={line}
                className="h-3.5 rounded-control bg-paper-edge"
                style={{ width: line === 3 ? "62%" : "100%" }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** An assistant answer that has been requested but has not started streaming. */
export function MessageSkeleton() {
  return (
    <div role="status" aria-label="Retrieving passages" className="measure">
      <SkeletonText lines={4} />
    </div>
  );
}
