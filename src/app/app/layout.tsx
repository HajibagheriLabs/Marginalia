import { Suspense } from "react";

import { LimitProvider } from "@/components/limit-dialog";
import { DemoBanner } from "@/components/workspace/demo-banner";
import { LibraryRail } from "@/components/workspace/library-rail";
import { RailSkeleton } from "@/components/workspace/workbench-skeleton";
import { UploadProvider } from "@/components/upload/upload-provider";
import { UploadQueue } from "@/components/upload/upload-queue";
import { requireUser } from "@/lib/auth-server";
import { isDemoUser } from "@/lib/demo";
import { listUserConversations } from "@/lib/conversations";
import { listUserDocuments } from "@/lib/documents";
import { readWorkspacePrefs } from "@/lib/workspace-prefs.server";
import { RAIL_WIDTH, RAIL_WIDTH_COLLAPSED } from "@/lib/workspace-prefs";

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
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE SHELL DOES NOT WAIT FOR THE LIBRARY
 *
 * This layout used to `await` the document list and the conversation list
 * before returning anything, which meant two database round trips stood between
 * the request and the first pixel — of the rail, the banner, AND the page,
 * because a layout that has not resolved renders none of its children.
 *
 * Those two queries now live in `<RailContents>` behind a Suspense boundary, so
 * the shell is returned immediately and the rail fills in. What is still
 * awaited here is deliberate and cheap: `requireUser` is the security boundary
 * and cannot be deferred, and `readWorkspacePrefs` is a cookie read that
 * decides the rail's WIDTH — deferring that would render 240px, then snap to
 * 56px for someone who collapsed it, which is the layout shift this whole pass
 * exists to remove.
 */
export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  const { railCollapsed } = await readWorkspacePrefs();
  const demo = isDemoUser(user.id);

  return (
    <LimitProvider>
      <UploadProvider userId={user.id}>
        <div className="flex h-dvh min-h-0 flex-col overflow-hidden lg:flex-row">
          <Suspense
            fallback={
              // The rail's own frame at its remembered width, so the main
              // column starts in its final position rather than sliding right
              // when the lists arrive.
              <div
                style={{
                  width: railCollapsed ? RAIL_WIDTH_COLLAPSED : RAIL_WIDTH,
                }}
                className="hidden shrink-0 border-r border-edge bg-surface lg:flex lg:flex-col"
              >
                <RailSkeleton />
              </div>
            }
          >
            <RailContents
              userId={user.id}
              user={{ name: user.name ?? "", email: user.email }}
              railCollapsed={railCollapsed}
              demo={demo}
            />
          </Suspense>

          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            {/* Above the panes, inside the main column, so it is visible on
                every route of the workspace and survives navigation between
                documents — the restriction it explains does too. */}
            {demo ? <DemoBanner /> : null}
            {children}
          </main>
        </div>
        <UploadQueue />
      </UploadProvider>
    </LimitProvider>
  );
}

/**
 * The two library queries, isolated so they can suspend on their own.
 *
 * Separate component rather than an inline `await`: Suspense boundaries wrap
 * COMPONENTS, and awaiting in the layout body would suspend the layout itself —
 * which is the thing this arrangement exists to stop.
 */
async function RailContents({
  userId,
  user,
  railCollapsed,
  demo,
}: {
  userId: string;
  user: { name: string; email: string };
  railCollapsed: boolean;
  demo: boolean;
}) {
  const [documents, conversations] = await Promise.all([
    listUserDocuments(userId),
    listUserConversations(userId),
  ]);

  return (
    <LibraryRail
      documents={documents}
      conversations={conversations}
      user={user}
      initialCollapsed={railCollapsed}
      uploadsDisabled={demo}
    />
  );
}
