import { LimitProvider } from "@/components/limit-dialog";
import { DemoBanner } from "@/components/workspace/demo-banner";
import { LibraryRail } from "@/components/workspace/library-rail";
import { UploadProvider } from "@/components/upload/upload-provider";
import { UploadQueue } from "@/components/upload/upload-queue";
import { requireUser } from "@/lib/auth-server";
import { isDemoUser } from "@/lib/demo";
import { listUserConversations } from "@/lib/conversations";
import { listUserDocuments } from "@/lib/documents";
import { readWorkspacePrefs } from "@/lib/workspace-prefs.server";

/**
 * The workspace shell.
 *
 * `requireUser()` is the real gate. The proxy in src/proxy.ts also bounces
 * signed-out visitors here, but that is redirect UX only — it checks for the
 * presence of a cookie and nothing else. Authentication is decided here, on the
 * server, on every request.
 *
 * The rail and the upload queue both live in the LAYOUT so they survive
 * navigation between documents: the rail keeps its scroll position and its
 * collapsed state, and an upload keeps running while you read something else.
 *
 * `h-dvh` with `overflow-hidden` makes the shell exactly one viewport tall and
 * gives the panes a definite height to scroll inside. The document scrolls; the
 * application does not.
 *
 * `LimitProvider` is here for the same reason the upload queue is: a refused
 * upload and a spent daily allowance are both account-level facts, and both can
 * be triggered from a pane that is about to unmount. One dialog, above
 * everything that swaps.
 */
export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  const [{ railCollapsed }, documents, conversations] = await Promise.all([
    readWorkspacePrefs(),
    listUserDocuments(user.id),
    listUserConversations(user.id),
  ]);

  return (
    <LimitProvider>
      <UploadProvider userId={user.id}>
        <div className="flex h-dvh min-h-0 flex-col overflow-hidden lg:flex-row">
          <LibraryRail
            documents={documents}
            conversations={conversations}
            user={{ name: user.name ?? "", email: user.email }}
            initialCollapsed={railCollapsed}
            uploadsDisabled={isDemoUser(user.id)}
          />
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            {/* Above the panes, inside the main column, so it is visible on
                every route of the workspace and survives navigation between
                documents — the restriction it explains does too. */}
            {isDemoUser(user.id) ? <DemoBanner /> : null}
            {children}
          </main>
        </div>
        <UploadQueue />
      </UploadProvider>
    </LimitProvider>
  );
}
