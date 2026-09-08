import { Skeleton, SkeletonText } from "@/components/skeleton";

/**
 * The auth panel, at the size the form will be.
 *
 * The layout already draws the wordmark and the --surface card, so only the
 * form inside is a placeholder: a heading, a line of description, two labelled
 * fields, and the submit button. Same heights, same gaps, so the card does not
 * resize when the real form replaces this.
 */
export default function Loading() {
  return (
    <div role="status" aria-label="Loading" className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-4 w-24" />
        <SkeletonText lines={1} className="w-[70%]" />
      </div>

      <div className="flex flex-col gap-4">
        {Array.from({ length: 2 }, (_, index) => (
          <div key={index} className="flex flex-col gap-1.5">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
        <Skeleton className="h-8 w-full" />
      </div>
    </div>
  );
}
