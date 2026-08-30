"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { deleteDocument } from "@/server/actions/documents";

/**
 * Removing a document from the reading pane header.
 *
 * This exists because the upload quota exists. A cap with no way to free space
 * is a cap that eventually bricks the account, and the message that announces
 * it ("delete one to upload another") has to be true.
 */
export function DocumentActions({
  documentId,
  title,
}: {
  documentId: string;
  title: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();

  function confirm() {
    startTransition(async () => {
      const result = await deleteDocument(documentId);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      // The document that was open no longer exists; go back to the workspace.
      router.push("/app");
      router.refresh();
    });
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={pending}
        onClick={() => setConfirming(true)}
        aria-label={`Delete ${title}`}
      >
        <Trash2 aria-hidden />
      </Button>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        destructive
        title="Delete this document?"
        description={`"${title}" is removed from your library along with the stored file. This cannot be undone.`}
        confirmLabel="Delete document"
        onConfirm={confirm}
      />
    </>
  );
}
