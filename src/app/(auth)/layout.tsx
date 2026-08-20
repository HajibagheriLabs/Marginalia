import Link from "next/link";

import { APP_NAME } from "@/lib/brand";

/**
 * The auth shell: a --surface panel centred on --room.
 *
 * There is no colour on any of these pages, and that is a rule rather than a
 * preference. Colour in this application means citation, and there are no
 * citations on a sign-in page.
 */
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-1 flex-col items-center justify-center px-5 py-14">
      <div className="w-full max-w-[400px]">
        <Link
          href="/"
          className="mb-6 inline-block rounded-control text-page-title font-semibold text-text"
        >
          {APP_NAME}
        </Link>

        <div className="rounded-panel border border-edge bg-surface p-6">
          {children}
        </div>
      </div>
    </div>
  );
}
