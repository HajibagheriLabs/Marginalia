import { LibraryRail } from "@/components/workspace/library-rail";
import { requireUser } from "@/lib/auth-server";
import { PLACEHOLDER_DOCUMENTS } from "@/lib/placeholder";
import { readWorkspacePrefs } from "@/lib/workspace-prefs.server";

/**
 * The workspace shell.
 *
 * `requireUser()` is the real gate. The proxy in src/proxy.ts also bounces
 * signed-out visitors here, but that is redirect UX only — it checks for the
 * presence of a cookie and nothing else. Authentication is decided here, on the
 * server, on every request.
 *
 * The rail lives in the LAYOUT so it survives navigation between documents: its
 * scroll position, its collapsed state, and the drawer all persist while the
 * panes underneath swap.
 *
 * `h-dvh` with `overflow-hidden` makes the shell exactly one viewport tall and
 * gives the panes a definite height to scroll inside. The document scrolls; the
 * application does not.
 */
export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  const { railCollapsed } = await readWorkspacePrefs();

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden lg:flex-row">
      <LibraryRail
        documents={PLACEHOLDER_DOCUMENTS}
        user={{ name: user.name ?? "", email: user.email }}
        initialCollapsed={railCollapsed}
      />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</main>
    </div>
  );
}
