"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ConversationSummary } from "@/lib/chat/types";
import { inkForIndex, inkVar } from "@/lib/ink";
import { cn } from "@/lib/utils";
import {
  deleteConversation,
  renameConversation,
} from "@/server/actions/conversations";

/**
 * CONVERSATIONS IN THE LIBRARY RAIL.
 *
 * Under the documents, because that is the dependency order: you upload a
 * document, then you ask about it. A thread with no documents in it cannot
 * answer anything, so it never leads.
 *
 * Each row carries the ink swatches of its scope, computed the same positional
 * way the conversation itself computes them. A thread you remember as "the
 * yellow-and-pink one" is findable as that, because the rail and the answer
 * derive the colours from the same array in the same order.
 *
 * An untitled conversation is one that was created and never asked anything.
 * It reads as "New conversation" rather than acquiring a name it did not earn.
 */
export function ConversationList({
  conversations,
  collapsed = false,
  onNavigate,
}: {
  conversations: ConversationSummary[];
  /** The 56px icon rail hides the list entirely; titles are the whole point. */
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();

  const [renaming, setRenaming] = useState<ConversationSummary | null>(null);
  const [deleting, setDeleting] = useState<ConversationSummary | null>(null);

  const activeId = pathname.startsWith("/app/conversations/")
    ? decodeURIComponent(pathname.split("/")[3] ?? "")
    : null;

  if (collapsed) return null;

  return (
    <>
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-3 pb-1.5">
        <p className="label">Conversations</p>
        <Button
          asChild
          variant="ghost"
          size="icon-xs"
          aria-label="Start a new conversation"
        >
          {/* "New" is a route, not a row. Nothing is written until the first
              question, so a new conversation is simply the workspace with no
              thread open — which is why the rail never fills with empties. */}
          <Link href="/app" onClick={onNavigate}>
            <Plus aria-hidden />
          </Link>
        </Button>
      </div>

      <ul className="flex shrink-0 flex-col gap-0.5 px-2 pb-2">
        {conversations.length === 0 ? (
          <li className="px-2 py-1.5 text-body-sm text-text-faint">
            No conversations yet.
          </li>
        ) : (
          conversations.map((conversation) => (
            <li key={conversation.id} className="group/row relative">
              <Link
                href={`/app/conversations/${conversation.id}`}
                onClick={onNavigate}
                aria-current={conversation.id === activeId ? "page" : undefined}
                className={cn(
                  "flex min-w-0 items-center gap-2 rounded-control py-1.5 pr-8 pl-2",
                  "text-body-sm hover:bg-surface-raised",
                  conversation.id === activeId
                    ? "bg-surface-raised text-text"
                    : "text-text-muted",
                )}
              >
                <span className="flex shrink-0 items-center gap-0.5">
                  {conversation.documentIds.slice(0, 4).map((id, index) => (
                    <span
                      key={id}
                      aria-hidden
                      className="size-1.5 rounded-chip"
                      style={{ background: inkVar(inkForIndex(index)) }}
                    />
                  ))}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {conversation.title ?? "New conversation"}
                </span>
              </Link>

              <div className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 focus-within:opacity-100 group-hover/row:opacity-100">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Actions for ${conversation.title ?? "this conversation"}`}
                    >
                      <MoreHorizontal aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setRenaming(conversation)}>
                      <Pencil aria-hidden />
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="danger"
                      onSelect={() => setDeleting(conversation)}
                    >
                      <Trash2 aria-hidden />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </li>
          ))
        )}
      </ul>

      {/* Keyed by id so the field is seeded on mount rather than synced in an
          effect — choosing a different conversation mounts a different form. */}
      {renaming ? (
        <RenameDialog
          key={renaming.id}
          conversation={renaming}
          onClose={() => setRenaming(null)}
          onDone={() => router.refresh()}
        />
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete this conversation?"
        description="The questions, the answers, and their retrieval traces are removed. The documents are not touched."
        confirmLabel="Delete conversation"
        destructive
        onConfirm={async () => {
          if (!deleting) return;

          const result = await deleteConversation(deleting.id);
          if (!result.ok) {
            toast.error(result.error);
            return;
          }

          const wasOpen = deleting.id === activeId;
          setDeleting(null);
          // Leaving the reader on a route that no longer resolves would be a
          // 404 they caused by pressing a button in the rail.
          if (wasOpen) router.push("/app");
          else router.refresh();
        }}
      />
    </>
  );
}

function RenameDialog({
  conversation,
  onClose,
  onDone,
}: {
  conversation: ConversationSummary;
  onClose: () => void;
  onDone: () => void;
}) {
  const [value, setValue] = useState(conversation.title ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    const title = value.trim();
    if (title.length === 0) return;

    setSaving(true);
    try {
      const result = await renameConversation(conversation.id, title);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      onDone();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename conversation</DialogTitle>
          <DialogDescription>
            The name appears in the library rail. It does not change the
            answers.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="conversation-title">Name</Label>
          <Input
            id="conversation-title"
            value={value}
            maxLength={120}
            autoFocus
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void save();
              }
            }}
          />
        </div>

        <DialogFooter>
          <Button variant="ghost" size="lg" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            size="lg"
            onClick={() => void save()}
            disabled={saving || value.trim().length === 0}
          >
            Save name
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
