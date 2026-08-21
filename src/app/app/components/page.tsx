import type { Metadata } from "next";

import { ComponentGallery } from "./gallery";

export const metadata: Metadata = { title: "Components" };

/**
 * Placeholder route: the component inventory, at /app/components. Like the
 * settings page it has no conversation pane — there is nothing here to ask
 * questions about.
 */
export default function ComponentsPage() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-room">
      <ComponentGallery />
    </div>
  );
}
