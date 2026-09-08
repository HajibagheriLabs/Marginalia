import Link from "next/link";

import { Button } from "@/components/ui/button";
import { APP_NAME } from "@/lib/brand";

/**
 * 404, for anything outside the workspace.
 *
 * Themed, monochrome, and short. It states the fact and offers the two places
 * worth going: the home page, and the demo — which is the only route a
 * signed-out visitor can reach that has anything in it.
 *
 * No colour, because there is no citation on this page. No illustration,
 * because the design system has no illustrations.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-edge">
        <div className="mx-auto w-full max-w-[1180px] px-5 py-4 sm:px-8">
          <Link
            href="/"
            className="focus-ring rounded-control text-section-title text-text"
          >
            {APP_NAME}
          </Link>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[1180px] flex-1 flex-col justify-center gap-5 px-5 py-14 sm:px-8">
        <p className="num text-mono-sm text-text-faint">404</p>
        <h1 className="max-w-[20ch] text-page-title text-text sm:text-[28px] sm:leading-[1.2]">
          There is no page at this address.
        </h1>
        <p className="max-w-[52ch] text-body text-text-muted">
          The link may be out of date, or the document may have been deleted.
        </p>
        <div className="flex flex-wrap gap-3 pt-1">
          <Button asChild>
            <Link href="/">Go to the home page</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/demo" prefetch={false}>
              Open the demo
            </Link>
          </Button>
        </div>
      </main>
    </div>
  );
}
