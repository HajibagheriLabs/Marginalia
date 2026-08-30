import { cn } from "@/lib/utils";

/**
 * A determinate progress bar.
 *
 * The fill is `--text`, not a colour. Progress is chrome: it reports the state
 * of a transfer, and in this design system colour means a citation and nothing
 * else. A green or blue bar here would be the first thing the eye lands on and
 * it would be pointing at a file upload.
 *
 * The fill is not transitioned. It moves because real progress events arrive,
 * the same way streaming text moves — an eased width would be an animation
 * inventing motion the transfer did not have.
 */
export function ProgressBar({
  value,
  label,
  className,
}: {
  /** 0–100. Clamped. */
  value: number;
  /** Announced to screen readers, e.g. "Uploading contract.pdf". */
  label: string;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(100, value));

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn(
        "h-0.5 w-full overflow-hidden rounded-chip bg-edge-strong",
        className,
      )}
    >
      <div className="h-full bg-text" style={{ width: `${clamped}%` }} />
    </div>
  );
}
