/**
 * Upload rules, shared by the browser and the server.
 *
 * Everything here is ISOMORPHIC on purpose. The client validates a file before
 * it spends a byte of the user's bandwidth, and the server re-validates the
 * same claims against what actually landed in the blob store. Both sides read
 * the same table, so "accepted here, rejected there" cannot happen — but the
 * client's answer is a courtesy and the server's answer is the decision. The
 * client is never trusted; it is only made fast.
 */

/** 25 MB. Stated in the dropzone, enforced on the client, enforced in the token. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_UPLOAD_LABEL = "25 MB";

/**
 * Per-user document cap, checked before a token is minted.
 *
 * This is a free-tier project: Neon, Qdrant, and Blob all have hard quotas, and
 * a single user uploading without limit would spend them for everyone. The
 * check lives on the server because a client-side cap is a suggestion.
 */
export const MAX_DOCUMENTS_PER_USER = 25;

export interface AcceptedFileType {
  /** Lowercase, with the dot. */
  extension: string;
  /**
   * What the blob is stored as. The client sends this explicitly rather than
   * letting the store infer it, so the token's allowlist can be exact.
   */
  contentType: string;
  label: string;
  /**
   * What browsers actually report in `File.type` for this extension. Empty
   * string is included where the OS commonly has no mapping — Windows reports
   * "" for .md constantly, and rejecting on that alone would reject valid
   * files for a reason the user cannot act on.
   */
  browserTypes: string[];
}

export const ACCEPTED_FILE_TYPES: AcceptedFileType[] = [
  {
    extension: ".pdf",
    contentType: "application/pdf",
    label: "PDF",
    browserTypes: ["application/pdf", ""],
  },
  {
    extension: ".docx",
    contentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    label: "DOCX",
    browserTypes: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "",
    ],
  },
  {
    extension: ".txt",
    contentType: "text/plain",
    label: "TXT",
    browserTypes: ["text/plain", ""],
  },
  {
    extension: ".md",
    contentType: "text/markdown",
    label: "Markdown",
    browserTypes: ["text/markdown", "text/x-markdown", "text/plain", ""],
  },
];

/** The canonical types a blob may be stored as. Used as the token allowlist. */
export const ACCEPTED_CONTENT_TYPES = ACCEPTED_FILE_TYPES.map(
  (type) => type.contentType,
);

/** For the file input's `accept`. Extensions first — the reliable half. */
export const ACCEPT_ATTRIBUTE = [
  ...ACCEPTED_FILE_TYPES.map((type) => type.extension),
  ...ACCEPTED_CONTENT_TYPES,
].join(",");

/** "PDF, DOCX, TXT, or Markdown" — used in every rejection message. */
export const ACCEPTED_TYPES_SENTENCE = (() => {
  const labels = ACCEPTED_FILE_TYPES.map((type) => type.label);
  return `${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}`;
})();

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

export function matchAcceptedType(filename: string): AcceptedFileType | null {
  const extension = extensionOf(filename);
  return (
    ACCEPTED_FILE_TYPES.find((type) => type.extension === extension) ?? null
  );
}

/** Sizes are numbers, so they are rendered in the mono face wherever they appear. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type UploadValidation =
  | { ok: true; type: AcceptedFileType }
  | { ok: false; message: string };

/**
 * Extension, then reported MIME type, then size — in that order, because the
 * first failure is the one worth reporting and extension is the check the user
 * can most easily act on.
 *
 * Messages state what happened and what to do, and never apologise.
 */
export function validateUpload(file: {
  name: string;
  size: number;
  type: string;
}): UploadValidation {
  const type = matchAcceptedType(file.name);
  if (!type) {
    const extension = extensionOf(file.name);
    return {
      ok: false,
      message: extension
        ? `${extension} files aren't supported. Upload a ${ACCEPTED_TYPES_SENTENCE} file.`
        : `This file has no extension. Upload a ${ACCEPTED_TYPES_SENTENCE} file.`,
    };
  }

  // A reported type that contradicts the extension means the file is not what
  // it is named. An ABSENT type means the OS had no mapping, which is normal.
  const reported = file.type.split(";")[0].trim().toLowerCase();
  if (!type.browserTypes.includes(reported)) {
    return {
      ok: false,
      message: `This file is named ${type.extension} but the browser reports it as ${reported}. Upload a ${ACCEPTED_TYPES_SENTENCE} file.`,
    };
  }

  if (file.size === 0) {
    return { ok: false, message: "This file is empty. There is nothing to read." };
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      message: `This file is ${formatBytes(file.size)}. The limit is ${MAX_UPLOAD_LABEL}.`,
    };
  }

  return { ok: true, type };
}

/** The document title shown in the rail: the filename without its extension. */
export function documentTitleFromFilename(filename: string): string {
  const extension = extensionOf(filename);
  const base = extension ? filename.slice(0, -extension.length) : filename;
  return base.trim() || filename;
}

/**
 * Strip a filename down to something safe to put in a URL path.
 *
 * The filename comes from the user's disk, so it can contain slashes, control
 * characters, or 300 characters of nonsense. Everything outside the safe set
 * collapses to a single dash.
 */
function sanitizeFilename(filename: string): string {
  const extension = extensionOf(filename);
  const base = extension ? filename.slice(0, -extension.length) : filename;
  const safeBase =
    base
      .normalize("NFKD")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 80) || "document";
  return `${safeBase}${extension}`;
}

/** Where a user's uploads live in the store. One prefix per user. */
export function blobPrefixForUser(userId: string): string {
  return `documents/${userId}/`;
}

export function buildBlobPathname(userId: string, filename: string): string {
  return `${blobPrefixForUser(userId)}${sanitizeFilename(filename)}`;
}

/**
 * Does this pathname belong to this user?
 *
 * The client chooses the pathname it uploads to — that is how @vercel/blob's
 * client upload works, since the pathname is baked into the token the server
 * mints. So the server re-derives what the pathname is ALLOWED to look like and
 * refuses to mint a token for anything else. Without this a signed-in user
 * could request a token for another user's prefix.
 *
 * It is not the security boundary on its own: ownership of a DOCUMENT is
 * decided by the `user_id` column, which is stamped from the session and never
 * from the request. This just stops the store's namespace being scribbled on.
 */
export function isOwnedBlobPathname(pathname: string, userId: string): boolean {
  const prefix = blobPrefixForUser(userId);
  if (!pathname.startsWith(prefix)) return false;

  const filename = pathname.slice(prefix.length);
  // One segment, no traversal, and an extension we accept.
  if (!filename || filename.includes("/") || filename.includes("..")) {
    return false;
  }
  return matchAcceptedType(filename) !== null;
}
