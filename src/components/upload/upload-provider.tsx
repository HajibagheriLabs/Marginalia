"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";

import { useLimitDialog } from "@/components/limit-dialog";
import { isDemoUser } from "@/lib/demo";
import {
  checkUploadAllowance,
  registerUploadedDocument,
} from "@/server/actions/documents";
import {
  buildBlobPathname,
  matchAcceptedType,
  validateUpload,
} from "@/lib/upload";

/**
 * THE UPLOAD QUEUE.
 *
 * Owns every in-flight upload for the whole workspace, so progress survives
 * navigating between documents — the provider sits in the /app layout, above
 * the panes that swap.
 *
 * Files are uploaded ONE AT A TIME. Parallel uploads from a browser split the
 * same uplink between them, so five files all finish at roughly the same late
 * moment instead of one finishing early; sequential also keeps the per-file
 * progress numbers meaningful. One failure removes exactly one item from the
 * queue and the loop continues — a bad file in the middle of a drop of ten must
 * not cancel the other nine.
 *
 * The queue is driven by an explicit async pump rather than an effect. An
 * effect that starts work when it notices queued items has to guard against
 * re-entry on every render; a pump called from the one place work is added does
 * not.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * LIMITS ARE CHECKED TWICE, AND ONLY THE SECOND ONE DECIDES.
 *
 * `enqueue` asks the server whether there is room BEFORE the first byte moves,
 * and opens the limit dialog if there is not. That check is a courtesy: it
 * saves the user from watching a 25 MB transfer succeed and then be thrown
 * away, and it is the reason the dialog names a ceiling rather than a failed
 * upload.
 *
 * The check that DECIDES runs inside `registerUploadedDocument`, in the same
 * transaction as the insert. When it refuses, the action returns the same
 * `LimitNotice` shape and the same dialog opens — the only difference being
 * that the blob has already been discarded server-side.
 */

export type UploadItemStatus =
  | "queued"
  | "uploading"
  | "recording"
  | "done"
  | "error"
  | "canceled";

export interface UploadItem {
  id: string;
  name: string;
  size: number;
  status: UploadItemStatus;
  /** 0–100, from real progress events. */
  progress: number;
  /** Present on `error`: what happened and what to do. */
  error?: string;
  documentId?: string;
  /** False when the file was rejected before upload — nothing to retry. */
  retryable: boolean;
}

interface UploadContextValue {
  /**
   * True when this account may not upload at all — currently only the shared
   * demo workspace.
   *
   * Exposed on the context rather than passed down, because the dropzone wraps
   * the reading pane, which is a Server Component that has no reason to know
   * about accounts. A COURTESY only: the refusal that matters is in the Blob
   * token route and in `registerUploadedDocument`.
   */
  uploadsDisabled: boolean;
  items: UploadItem[];
  /**
   * Checks the account's allowance, validates each file, then queues.
   *
   * Async because the allowance check is a round trip. Callers fire and
   * forget — the queue is the progress indicator, so there is nothing useful
   * to await at a click handler.
   */
  enqueue: (files: File[]) => Promise<void>;
  cancel: (id: string) => void;
  retry: (id: string) => void;
  dismiss: (id: string) => void;
  clearFinished: () => void;
}

const UploadContext = createContext<UploadContextValue | null>(null);

export function useUploads(): UploadContextValue {
  const context = useContext(UploadContext);
  if (!context) {
    throw new Error("useUploads must be used inside <UploadProvider>");
  }
  return context;
}

/**
 * Above this, ask the SDK to split the file into parts. Parts upload in
 * parallel and a failed part is retried on its own, which matters most for the
 * large files this whole client-upload design exists to support.
 */
const MULTIPART_THRESHOLD = 8 * 1024 * 1024;

/** How long a finished item stays on screen before it clears itself. */
const DONE_LINGER_MS = 4000;

/** A queued file plus the handles needed to run or abort it. */
interface PendingUpload {
  id: string;
  file: File;
  controller: AbortController;
}

const IN_FLIGHT: UploadItemStatus[] = ["queued", "uploading", "recording"];

export function UploadProvider({
  userId,
  children,
}: {
  /** From the session, on the server. Only used to build the blob pathname. */
  userId: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { showLimit } = useLimitDialog();
  const [items, setItems] = useState<UploadItem[]>([]);

  const uploadsDisabled = isDemoUser(userId);

  /** Waiting to run, in order. */
  const pendingRef = useRef<PendingUpload[]>([]);
  /** id -> abort handle, for cancelling an upload in flight. */
  const controllersRef = useRef(new Map<string, AbortController>());
  /** id -> the File, kept so a failed upload can be retried without re-picking it. */
  const filesRef = useRef(new Map<string, File>());
  const runningRef = useRef(false);
  const timersRef = useRef(new Set<ReturnType<typeof setTimeout>>());

  // Leaving a page mid-upload should stop the transfer, not leave it running
  // against a component that no longer exists.
  useEffect(() => {
    const timers = timersRef.current;
    const controllers = controllersRef.current;
    return () => {
      timers.forEach(clearTimeout);
      controllers.forEach((controller) => controller.abort());
    };
  }, []);

  const patch = useCallback((id: string, changes: Partial<UploadItem>) => {
    setItems((previous) =>
      previous.map((item) => (item.id === id ? { ...item, ...changes } : item)),
    );
  }, []);

  const scheduleRemoval = useCallback((id: string) => {
    const timer = setTimeout(() => {
      timersRef.current.delete(timer);
      filesRef.current.delete(id);
      setItems((previous) => previous.filter((item) => item.id !== id));
    }, DONE_LINGER_MS);
    timersRef.current.add(timer);
  }, []);

  /** Run one file end to end: token, direct upload, then the row. */
  const runOne = useCallback(
    async ({ id, file, controller }: PendingUpload) => {
      const type = matchAcceptedType(file.name);
      if (!type) {
        patch(id, {
          status: "error",
          error: "That file type is not supported.",
          retryable: false,
        });
        return;
      }

      patch(id, { status: "uploading", progress: 0 });

      try {
        const blob = await upload(buildBlobPathname(userId, file.name), file, {
          // The store is configured for private access: a blob is not readable
          // from its URL alone. The viewer will fetch it through a short-lived
          // signed URL rather than a public link.
          access: "private",
          handleUploadUrl: "/api/blob/upload",
          // Sent explicitly rather than inferred from the extension, so the
          // token's content-type allowlist can be exact.
          contentType: type.contentType,
          multipart: file.size > MULTIPART_THRESHOLD,
          abortSignal: controller.signal,
          onUploadProgress: ({ percentage }) => {
            patch(id, { progress: percentage });
          },
        });

        // The bytes are in the store; nothing in the database knows yet.
        patch(id, { status: "recording", progress: 100 });

        const result = await registerUploadedDocument({
          blobUrl: blob.url,
          pathname: blob.pathname,
          filename: file.name,
          contentType: type.contentType,
          byteSize: file.size,
        });

        if (!result.ok) {
          // A limit refusal is not a retryable error: retrying changes
          // nothing until a document is deleted. It gets the dialog, and the
          // queue item says so without offering a Retry button.
          if (result.limit) {
            showLimit(result.limit);
            patch(id, {
              status: "error",
              error: result.limit.nextStep,
              retryable: false,
            });
            return;
          }
          patch(id, { status: "error", error: result.error });
          return;
        }

        patch(id, { status: "done", documentId: result.documentId });
        // Pull the new row into the rail.
        router.refresh();
        scheduleRemoval(id);
      } catch (error) {
        if (controller.signal.aborted) {
          patch(id, { status: "canceled" });
          return;
        }
        console.error("[upload] failed", error);
        patch(id, {
          status: "error",
          error:
            error instanceof Error && error.message
              ? error.message
              : "The upload failed. Try again.",
        });
      } finally {
        controllersRef.current.delete(id);
      }
    },
    [patch, router, scheduleRemoval, showLimit, userId],
  );

  /**
   * Drain the queue, one file at a time. A re-entrant call returns immediately;
   * the loop already running picks up anything added while it was working.
   */
  const pump = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    try {
      for (;;) {
        const next = pendingRef.current.shift();
        if (!next) break;
        if (next.controller.signal.aborted) {
          patch(next.id, { status: "canceled" });
          continue;
        }
        // Sequential by construction: awaiting inside the loop IS the rule.
        await runOne(next);
      }
    } finally {
      runningRef.current = false;
    }
  }, [patch, runOne]);

  const enqueue = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      // Nothing is queued and no round trip is made. The server would refuse
      // anyway; this just avoids showing a demo visitor four failed rows.
      if (uploadsDisabled) return;

      // Ask before transferring. The answer is about the ACCOUNT, so it is
      // asked once for the whole drop rather than once per file, and a drop of
      // ten files onto an account with three slots left is refused as a whole
      // — telling someone "three of your ten uploaded" after the fact is worse
      // than telling them the ceiling first.
      const allowance = await checkUploadAllowance(files.length);
      if (!allowance.ok) {
        if (allowance.limit) showLimit(allowance.limit);
        return;
      }

      const accepted: PendingUpload[] = [];
      const added: UploadItem[] = [];

      for (const file of files) {
        const id = crypto.randomUUID();
        const validation = validateUpload(file);

        if (!validation.ok) {
          // A rejected file still enters the queue — as an error. Dropping it
          // silently would leave the user counting files and wondering.
          added.push({
            id,
            name: file.name,
            size: file.size,
            status: "error",
            progress: 0,
            error: validation.message,
            retryable: false,
          });
          continue;
        }

        const controller = new AbortController();
        controllersRef.current.set(id, controller);
        filesRef.current.set(id, file);
        accepted.push({ id, file, controller });
        added.push({
          id,
          name: file.name,
          size: file.size,
          status: "queued",
          progress: 0,
          retryable: true,
        });
      }

      setItems((previous) => [...previous, ...added]);
      pendingRef.current.push(...accepted);
      void pump();
    },
    [pump, showLimit, uploadsDisabled],
  );

  const cancel = useCallback(
    (id: string) => {
      // Aborts an upload in flight; one still queued is marked aborted and the
      // pump skips it when it gets there.
      controllersRef.current.get(id)?.abort();
      patch(id, { status: "canceled" });
    },
    [patch],
  );

  const retry = useCallback(
    (id: string) => {
      if (pendingRef.current.some((pending) => pending.id === id)) return;

      const file = filesRef.current.get(id);
      if (!file) return;

      const controller = new AbortController();
      controllersRef.current.set(id, controller);
      pendingRef.current.push({ id, file, controller });
      patch(id, { status: "queued", progress: 0, error: undefined });
      void pump();
    },
    [patch, pump],
  );

  const dismiss = useCallback((id: string) => {
    controllersRef.current.get(id)?.abort();
    controllersRef.current.delete(id);
    filesRef.current.delete(id);
    pendingRef.current = pendingRef.current.filter(
      (pending) => pending.id !== id,
    );
    setItems((previous) => previous.filter((item) => item.id !== id));
  }, []);

  const clearFinished = useCallback(() => {
    setItems((previous) => {
      const kept = previous.filter((item) => IN_FLIGHT.includes(item.status));
      const keptIds = new Set(kept.map((item) => item.id));
      for (const id of filesRef.current.keys()) {
        if (!keptIds.has(id)) filesRef.current.delete(id);
      }
      return kept;
    });
  }, []);

  const value = useMemo<UploadContextValue>(
    () => ({
      uploadsDisabled,
      items,
      enqueue,
      cancel,
      retry,
      dismiss,
      clearFinished,
    }),
    [uploadsDisabled, items, enqueue, cancel, retry, dismiss, clearFinished],
  );

  return (
    <UploadContext.Provider value={value}>{children}</UploadContext.Provider>
  );
}
