import { Info } from "lucide-react";

import { DEMO_BANNER } from "@/lib/demo";

/**
 * THE DEMO BANNER. Persistent, `--warn`, and not dismissible.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY IT IS COLOURED AT ALL, IN A DESIGN SYSTEM WHERE COLOUR MEANS A CITATION
 *
 * Because `--warn` is a SYSTEM STATE, which is the one category of colour the
 * Light Table rules allow on chrome. It is amber-orange rather than citrine
 * specifically so it can never be read as a highlighter ink — the inks live on
 * the paper sheet and on the chips that point at it, and this is neither.
 *
 * Being in a shared, resettable, upload-disabled workspace is exactly a system
 * state: it is true for the whole session, it changes what the interface can
 * do, and it is not an error.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY IT CANNOT BE DISMISSED
 *
 * Because the fact it states does not stop being true when you close it. A
 * visitor who dismisses this and then clicks Upload gets a refusal with no
 * explanation on screen — the banner IS the explanation, and a dismissible one
 * is only present until the moment it is needed.
 *
 * It says what is disabled rather than only that this is a demo, for the same
 * reason. "You're in the demo" does not tell anyone why the Upload button
 * refused them.
 */
export function DemoBanner() {
  return (
    <div
      role="status"
      className="flex shrink-0 items-start gap-2.5 border-b border-edge bg-surface px-4 py-2.5"
    >
      <Info
        className="mt-px size-3.5 shrink-0 text-warn"
        aria-hidden="true"
      />
      <div className="min-w-0">
        <p className="text-body-sm font-medium text-warn">{DEMO_BANNER.title}</p>
        <p className="mt-0.5 text-body-sm text-text-muted">
          {DEMO_BANNER.detail}
        </p>
      </div>
    </div>
  );
}
