"use client";

import { useCallback, useRef, useState } from "react";
import { Upload } from "lucide-react";

import { useUploads } from "@/components/upload/upload-provider";
import {
  ACCEPTED_TYPES_SENTENCE,
  MAX_UPLOAD_LABEL,
} from "@/lib/upload";
import { cn } from "@/lib/utils";

/**
 * Drag-and-drop over the reading pane.
 *
 * Wraps the pane rather than being a box inside it: the whole table is the drop
 * target, which is the behaviour people try first. The overlay only appears
 * when the drag actually carries FILES — dragging selected text across the pane
 * should not offer to upload it.
 *
 * `dragenter`/`dragleave` fire for every child element the pointer crosses, so
 * a naive `dragleave` handler flickers the overlay off the moment the cursor
 * passes over the paper sheet. The depth counter is the fix: increment on
 * enter, decrement on leave, and only hide at zero.
 */
export function UploadDropzone({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { enqueue } = useUploads();
  const [dragging, setDragging] = useState(false);
  const depthRef = useRef(0);

  const carriesFiles = (event: React.DragEvent) =>
    Array.from(event.dataTransfer.types).includes("Files");

  const onDragEnter = useCallback((event: React.DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    depthRef.current += 1;
    setDragging(true);
  }, []);

  const onDragLeave = useCallback((event: React.DragEvent) => {
    if (!carriesFiles(event)) return;
    depthRef.current = Math.max(0, depthRef.current - 1);
    if (depthRef.current === 0) setDragging(false);
  }, []);

  const onDragOver = useCallback((event: React.DragEvent) => {
    if (!carriesFiles(event)) return;
    // Without this the browser navigates to the dropped file.
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depthRef.current = 0;
      setDragging(false);
      void enqueue(Array.from(event.dataTransfer.files));
    },
    [enqueue],
  );

  return (
    <div
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={cn("relative flex min-h-0 flex-1 flex-col", className)}
    >
      {children}

      {dragging ? (
        <div
          aria-hidden
          className="absolute inset-0 z-30 flex items-center justify-center bg-room/85 p-6"
        >
          <div className="flex flex-col items-center gap-2 rounded-panel border border-dashed border-edge-strong px-8 py-7 text-center">
            <Upload aria-hidden className="size-5 text-text-muted" />
            <p className="text-body font-medium text-text">Drop to upload</p>
            <p className="text-body-sm text-text-muted">
              {ACCEPTED_TYPES_SENTENCE}, up to{" "}
              <span className="num">{MAX_UPLOAD_LABEL}</span> each.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The same constraints, stated BEFORE anything is dragged.
 *
 * A limit the user only discovers by hitting it is a limit the interface chose
 * not to mention. This line goes under the empty reading pane and under the
 * Upload button in the rail.
 */
export function UploadHint({ className }: { className?: string }) {
  return (
    <p className={cn("text-body-sm text-text-faint", className)}>
      {ACCEPTED_TYPES_SENTENCE}, up to{" "}
      <span className="num">{MAX_UPLOAD_LABEL}</span> each.
    </p>
  );
}
