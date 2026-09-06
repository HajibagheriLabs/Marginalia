"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DELETE_CONFIRMATION } from "@/lib/account";
import { deleteAllMyData } from "@/server/actions/account";

/**
 * "Delete all my data", behind a typed confirmation.
 *
 * The dialog states the inventory before it asks — "3 documents and 8
 * conversations" rather than "everything" — because a number is what makes
 * somebody stop and check whether it is the number they expected. The confirm
 * button stays disabled until the word is typed exactly, and the server
 * re-checks the word regardless: this action is reachable without this dialog.
 *
 * The button says what it will do. Never "OK".
 */
export function DeleteAllData({
  documents,
  conversations,
}: {
  documents: number;
  conversations: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);

  const confirmed = typed === DELETE_CONFIRMATION;
  const nothingToDelete = documents === 0 && conversations === 0;

  async function confirm() {
    if (!confirmed) return;
    setPending(true);
    try {
      const result = await deleteAllMyData({ confirmation: typed });

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      setOpen(false);
      setTyped("");

      // What was actually removed, not what was requested. The warnings list
      // is the honest half: the rows are gone either way, and a file the store
      // refused to delete is something the user is entitled to know about.
      const removed = `${count(result.summary.documents, "document")} and ${count(
        result.summary.conversations,
        "conversation",
      )} deleted.`;

      if (result.summary.warnings.length > 0) {
        toast.warning(
          `${removed} Could not remove ${result.summary.warnings.join(" or ")}.`,
        );
      } else {
        toast.success(removed);
      }

      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-edge bg-surface px-4 py-3">
        <div>
          <p className="text-body text-text">Delete all my data</p>
          <p className="mt-0.5 text-body-sm text-text-muted">
            Removes every document, its stored file, its search index entries,
            and every conversation. Your account stays.
          </p>
        </div>
        <Button
          variant="destructive"
          size="lg"
          disabled={nothingToDelete}
          onClick={() => setOpen(true)}
        >
          Delete all my data
        </Button>
      </div>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setTyped("");
        }}
      >
        <DialogContent showClose={false}>
          <DialogHeader>
            <DialogTitle>Delete all your data?</DialogTitle>
            <DialogDescription>
              This removes {count(documents, "document")} and{" "}
              {count(conversations, "conversation")}, along with their stored
              files and search index entries. It cannot be undone. Your account
              and sign-in stay.
            </DialogDescription>
          </DialogHeader>

          <div>
            <Label htmlFor="delete-confirmation" className="text-body-sm">
              Type <span className="num text-text">{DELETE_CONFIRMATION}</span>{" "}
              to confirm
            </Label>
            <Input
              id="delete-confirmation"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              className="num mt-2"
              placeholder={DELETE_CONFIRMATION}
              disabled={pending}
            />
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="lg" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              size="lg"
              disabled={!confirmed || pending}
              onClick={() => void confirm()}
            >
              Delete all my data
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}
