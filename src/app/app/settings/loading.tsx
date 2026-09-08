import { Skeleton, SkeletonText } from "@/components/skeleton";

/**
 * Settings, while the usage counters are read.
 *
 * Three cards at the heights the real ones occupy. The numbers themselves come
 * from aggregate queries, which is what this is waiting on — so the rows are
 * drawn and only the values are blank.
 */
export default function Loading() {
  return (
    <div
      role="status"
      aria-label="Loading settings"
      className="mx-auto flex w-full max-w-[720px] flex-col gap-8 overflow-y-auto p-6"
    >
      <div className="flex flex-col gap-2">
        <Skeleton className="h-5 w-32" />
        <SkeletonText lines={1} className="w-[60%]" />
      </div>

      {Array.from({ length: 3 }, (_, card) => (
        <div
          key={card}
          className="flex flex-col gap-3 rounded-panel border border-edge bg-surface p-5"
        >
          <Skeleton className="h-3 w-28" />
          {Array.from({ length: 3 }, (_, row) => (
            <div key={row} className="flex items-center justify-between gap-4">
              <Skeleton className="h-3 w-[40%]" />
              <Skeleton className="h-3 w-16" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
