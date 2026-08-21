import type { Metadata } from "next";

import { requireUser } from "@/lib/auth-server";

export const metadata: Metadata = { title: "Settings" };

/**
 * Placeholder route. It exists so the user menu leads somewhere real and so the
 * shell can be navigated; it deliberately has no conversation pane, because
 * there is nothing here to ask questions about.
 */
export default async function SettingsPage() {
  const user = await requireUser();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-room">
      <header className="flex h-12 shrink-0 items-center border-b border-edge px-4">
        <h1 className="text-body font-medium text-text">Settings</h1>
      </header>

      <div className="mx-auto w-full max-w-[640px] px-5 py-10">
        <p className="label">Account</p>

        <dl className="mt-3 flex flex-col divide-y divide-edge rounded-panel border border-edge bg-surface">
          <div className="flex items-baseline justify-between gap-4 px-4 py-3">
            <dt className="text-body-sm text-text-muted">Name</dt>
            <dd className="text-body text-text">{user.name}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 px-4 py-3">
            <dt className="text-body-sm text-text-muted">Email</dt>
            <dd className="text-body text-text">{user.email}</dd>
          </div>
        </dl>

        <p className="mt-4 text-body-sm text-text-muted">
          Usage, embedding model, and document limits appear here once ingestion
          and retrieval are wired up.
        </p>
      </div>
    </div>
  );
}
