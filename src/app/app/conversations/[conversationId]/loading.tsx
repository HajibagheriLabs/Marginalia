import { WorkbenchSkeleton } from "@/components/workspace/workbench-skeleton";

/**
 * The workspace, while a route segment's data is in flight.
 *
 * Next.js swaps this for the page automatically, wrapped in the Suspense
 * boundary the App Router creates for the segment. It sits INSIDE the workspace
 * layout, so the rail and the demo banner are already on screen and only the
 * two panes are placeholders — which is the whole reason the rail lives in the
 * layout rather than in each page.
 *
 * The skeleton is the real geometry: the same two-pane split, the same
 * separator, the same bottom bar below 1024px. A placeholder with a different
 * shape moves the content when it is replaced, and the point of drawing one is
 * to stop exactly that.
 */
export default function Loading() {
  return <WorkbenchSkeleton />;
}
