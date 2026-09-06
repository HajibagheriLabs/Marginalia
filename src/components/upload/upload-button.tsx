"use client";

import { useRef } from "react";
import { Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useUploads } from "@/components/upload/upload-provider";
import { ACCEPT_ATTRIBUTE } from "@/lib/upload";

/**
 * The file picker in the library rail.
 *
 * A visually hidden `<input type="file">` driven by a real Button, rather than
 * a styled input: the input keeps the native picker, the keyboard behaviour,
 * and the `accept` filter, and the Button keeps the design system.
 *
 * `accept` lists extensions AND media types. Extensions are what actually works
 * across platforms — several OSes report no media type at all for .md and .txt,
 * and a media-type-only filter greys those files out in the picker.
 */
export function UploadButton({
  collapsed = false,
  className,
}: {
  collapsed?: boolean;
  className?: string;
}) {
  const { enqueue } = useUploads();
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT_ATTRIBUTE}
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          void enqueue(files);
          // Reset, so picking the same file twice in a row still fires change.
          event.target.value = "";
        }}
      />

      <Button
        variant="outline"
        size={collapsed ? "icon-sm" : "default"}
        className={className}
        onClick={() => inputRef.current?.click()}
        aria-label={collapsed ? "Upload a document" : undefined}
      >
        <Upload aria-hidden />
        {collapsed ? null : "Upload"}
      </Button>
    </>
  );
}
