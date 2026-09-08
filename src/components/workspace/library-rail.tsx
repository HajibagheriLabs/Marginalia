"use client";

import { useRef, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { Menu, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogTitle,
  DrawerContent,
} from "@/components/ui/dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RailBody } from "@/components/workspace/rail-body";
import { APP_NAME } from "@/lib/brand";
import type { ConversationSummary } from "@/lib/chat/types";
import type { DocumentListItemRow } from "@/lib/documents";
import {
  RAIL_COOKIE,
  RAIL_WIDTH,
  RAIL_WIDTH_COLLAPSED,
  writePrefCookie,
} from "@/lib/workspace-prefs";

/**
 * THE LIBRARY RAIL — 240px of documents down the left edge.
 *
 * It has three forms:
 *   - 240px expanded, the default;
 *   - a 56px icon rail, collapsed, with titles moved into tooltips;
 *   - below 1024px, a slide-over drawer opened from a compact top bar.
 *
 * The collapsed state is persisted in a cookie and read on the SERVER, so the
 * rail renders at its remembered width in the first paint. Storing it in
 * localStorage would render 240px, hydrate, and then snap to 56px, which is
 * exactly the kind of flash the theme handling already avoids.
 *
 * The drawer is a Dialog rather than a hand-rolled panel: it inherits the focus
 * trap, the scroll lock, and Escape-to-close, none of which are worth
 * reimplementing.
 */
export function LibraryRail({
  documents,
  conversations,
  user,
  initialCollapsed,
  uploadsDisabled,
}: {
  documents: DocumentListItemRow[];
  conversations: ConversationSummary[];
  user: { name: string; email: string };
  initialCollapsed: boolean;
  /** Hides the upload control. See the note on RailBody's own prop. */
  uploadsDisabled?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);
  /*
   * WHERE FOCUS GOES WHEN THE DRAWER CLOSES.
   *
   * Radix returns focus to its `DialogTrigger`, and this dialog is CONTROLLED —
   * it is opened by a button that sets state, not by a trigger — so there is no
   * trigger ref for it to return to and focus fell to `<body>`. Measured, not
   * assumed: after Escape the active element was the document body.
   *
   * For a keyboard user that means opening the library, closing it, and being
   * dumped at the top of the page with the whole header to tab through again.
   * The trap on the way IN was already correct; this is the other half.
   */
  const openerRef = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();

  // The rail is rendered by the layout, which does not receive route params.
  // Reading the active document out of the path keeps the rail and the reading
  // pane in agreement without threading state through every page.
  const activeDocumentId = pathname.startsWith("/app/documents/")
    ? decodeURIComponent(pathname.split("/")[3] ?? "")
    : null;

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    writePrefCookie(RAIL_COOKIE, next ? "collapsed" : "expanded");
  }

  return (
    <>
      {/* --- below 1024px: a compact top bar that opens the drawer --------- */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-edge bg-surface px-2 lg:hidden">
        <Button
          ref={openerRef}
          variant="ghost"
          size="icon-sm"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open the document library"
          aria-expanded={drawerOpen}
        >
          <Menu aria-hidden />
        </Button>
        <Link href="/app" className="rounded-control text-body font-semibold text-text">
          {APP_NAME}
        </Link>
      </header>

      <Dialog open={drawerOpen} onOpenChange={setDrawerOpen}>
        <DrawerContent
          onCloseAutoFocus={(event) => {
            // Radix would focus its trigger here, and there is not one.
            event.preventDefault();
            openerRef.current?.focus();
          }}
        >
          <DialogTitle className="sr-only">Document library</DialogTitle>
          <DialogDescription className="sr-only">
            Your documents, and the account menu.
          </DialogDescription>
          <RailBody
            documents={documents}
            conversations={conversations}
            activeDocumentId={activeDocumentId}
            user={user}
            uploadsDisabled={uploadsDisabled}
            onNavigate={() => setDrawerOpen(false)}
            headerAction={
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close the document library"
              >
                <X aria-hidden />
              </Button>
            }
          />
        </DrawerContent>
      </Dialog>

      {/* --- 1024px and up: the rail proper -------------------------------- */}
      <TooltipProvider delayDuration={300}>
        {/*
          `nav`, NOT `aside`.

          An `aside` announces as "complementary" — content related to the page
          but tangential to it. Everything in this rail is a link to another
          document or another conversation, which is the definition of
          navigation, and it is the PRIMARY navigation of the application. A
          screen-reader user jumping between landmarks should find it under
          "navigation", where they will look for it.
        */}
        <nav
          aria-label="Document library"
          style={{ width: collapsed ? RAIL_WIDTH_COLLAPSED : RAIL_WIDTH }}
          className="hidden shrink-0 border-r border-edge lg:block"
        >
          <RailBody
            documents={documents}
            conversations={conversations}
            activeDocumentId={activeDocumentId}
            user={user}
            uploadsDisabled={uploadsDisabled}
            collapsed={collapsed}
            headerAction={
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={toggleCollapsed}
                aria-label={
                  collapsed
                    ? "Expand the document library"
                    : "Collapse the document library"
                }
                aria-expanded={!collapsed}
              >
                {collapsed ? (
                  <PanelLeftOpen aria-hidden />
                ) : (
                  <PanelLeftClose aria-hidden />
                )}
              </Button>
            }
          />
        </nav>
      </TooltipProvider>
    </>
  );
}
