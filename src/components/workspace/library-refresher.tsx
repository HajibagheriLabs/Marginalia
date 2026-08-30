"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Keeps the library rail truthful while documents are being processed.
 *
 * The rail is server-rendered, so without this a document uploaded in one tab
 * sits at "Queued" forever until something else happens to navigate. This asks
 * the server to re-render the route on an interval, which updates every row's
 * dot, stage, and passage count at once.
 *
 * WHY A ROUTE REFRESH RATHER THAN POLLING EACH ROW. The rail can hold a dozen
 * documents; polling them individually would be a dozen requests carrying a
 * dozen integers, and the rows are rendered by the server anyway. One refresh
 * fetches the whole list in one round trip and needs no client-side merge.
 *
 * SLOWER THAN THE READING PANE, on purpose. `IngestProgress` polls the open
 * document every two seconds because that is where someone is actually looking
 * and where the "240 of 612" number lives. The rail only needs to be roughly
 * right, so it refreshes every eight — often enough that a stage change is
 * noticed quickly, rarely enough that a background tab with a long ingest
 * running is not re-rendering the layout continuously.
 *
 * Renders nothing. It is a behaviour, and the alternative — hanging this effect
 * off a component that also draws something — would tie it to that component's
 * position in the tree for no reason.
 */

const RAIL_REFRESH_INTERVAL_MS = 8_000;

export function LibraryRefresher({ active }: { active: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;

    const timer = setInterval(() => {
      // Only while the tab is visible. A background tab refreshing a layout
      // every eight seconds is work nobody can see, and browsers throttle the
      // timer unpredictably anyway — better to stop and resume on focus.
      if (document.visibilityState === "visible") router.refresh();
    }, RAIL_REFRESH_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [active, router]);

  return null;
}
