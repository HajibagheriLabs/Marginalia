"use client";

import Link from "next/link";
import { Upload } from "lucide-react";

import { DocumentListItem } from "@/components/document-list-item";
import { EmptyState } from "@/components/empty-state";
import { PlaceholderAction } from "@/components/workspace/placeholder-action";
import { UserMenu } from "@/components/workspace/user-menu";
import { APP_NAME } from "@/lib/brand";
import type { PlaceholderDocument } from "@/lib/placeholder";
import { cn } from "@/lib/utils";

/**
 * The contents of the library rail, shared by the desktop aside and the mobile
 * drawer so the two can never drift apart.
 *
 * Four regions, top to bottom: the wordmark, the upload action, the document
 * list (the only part that scrolls), and the user menu. Everything is
 * monochrome except the 6px status dots, which are system states.
 */
export function RailBody({
  documents,
  activeDocumentId,
  user,
  collapsed = false,
  headerAction,
  onNavigate,
}: {
  documents: PlaceholderDocument[];
  activeDocumentId: string | null;
  user: { name: string; email: string };
  /** The 56px icon rail. Never used inside the mobile drawer. */
  collapsed?: boolean;
  /** The collapse toggle, or the drawer's close button. */
  headerAction?: React.ReactNode;
  /** Called when a document link is followed — the drawer closes on navigation. */
  onNavigate?: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div
        className={cn(
          "flex h-12 shrink-0 items-center border-b border-edge",
          collapsed ? "justify-center px-2" : "justify-between pr-2 pl-3",
        )}
      >
        {collapsed ? null : (
          <Link
            href="/app"
            onClick={onNavigate}
            className="rounded-control text-section-title text-text"
          >
            {APP_NAME}
          </Link>
        )}
        {headerAction}
      </div>

      <div className={cn("shrink-0", collapsed ? "flex justify-center p-2" : "p-3")}>
        <PlaceholderAction
          variant="outline"
          size={collapsed ? "icon-sm" : "default"}
          className={collapsed ? undefined : "w-full"}
          aria-label={collapsed ? "Upload a document" : undefined}
          note="Uploading arrives with the ingestion pipeline."
        >
          <Upload aria-hidden />
          {collapsed ? null : "Upload"}
        </PlaceholderAction>
      </div>

      {collapsed ? null : (
        <p className="label shrink-0 px-3 pb-1.5">Documents</p>
      )}

      <div
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("a")) onNavigate?.();
        }}
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2",
          collapsed ? "items-center gap-1" : "gap-0.5",
        )}
      >
        {documents.length === 0 && !collapsed ? (
          <EmptyState
            className="px-2 py-6"
            title="No documents yet. Upload one to start asking questions."
          />
        ) : (
          documents.map((document) => (
            <DocumentListItem
              key={document.id}
              href={`/app/documents/${document.id}`}
              title={document.title}
              pageCount={document.pageCount}
              status={document.status}
              active={document.id === activeDocumentId}
              collapsed={collapsed}
            />
          ))
        )}
      </div>

      <div
        className={cn(
          "shrink-0 border-t border-edge p-2",
          collapsed && "flex justify-center",
        )}
      >
        <UserMenu name={user.name} email={user.email} collapsed={collapsed} />
      </div>
    </div>
  );
}
