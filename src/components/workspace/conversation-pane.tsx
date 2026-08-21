"use client";

import { MessageSquare } from "lucide-react";
import { toast } from "sonner";

import { Composer } from "@/components/composer";
import { EmptyState } from "@/components/empty-state";

/**
 * The right pane: header, message list, composer pinned to the bottom.
 *
 * Placeholder. The message list is empty and asking a question says so —
 * retrieval and generation land in a later step. What is real here is the
 * geometry: --surface panel, a fixed header and footer, and one scroll region
 * between them, so a streaming answer can only ever move the middle.
 */
export function ConversationPane({
  documentsInScope,
  canAsk,
  disabledReason,
}: {
  documentsInScope: number;
  canAsk: boolean;
  /** Required whenever `canAsk` is false — a dead composer must explain itself. */
  disabledReason?: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-edge px-4">
        <h2 className="truncate text-body font-medium text-text">
          New conversation
        </h2>
        <span className="num shrink-0 text-mono-xs text-text-faint">
          {documentsInScope} in scope
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
        <EmptyState
          icon={MessageSquare}
          title={
            canAsk
              ? "Ask a question and the answer will cite the passages it came from."
              : "Open a document to start a conversation about it."
          }
        />
      </div>

      <div className="shrink-0 border-t border-edge p-3">
        <Composer
          disabled={!canAsk}
          disabledReason={disabledReason}
          onSubmit={() =>
            toast("Answering arrives with the retrieval pipeline.", {
              description: "Your question was not sent anywhere.",
            })
          }
        />
      </div>
    </div>
  );
}
