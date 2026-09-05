/**
 * THE LOADING STATE: a paper-coloured page, at the size of the page that is
 * coming.
 *
 * Not a spinner on an empty room. Two reasons, and the second is the one that
 * matters:
 *
 *   - A spinner says "something is happening". This says "your document is
 *     here, it has not inked yet" — which is both more informative and the
 *     only honest description of what PDF.js is doing.
 *   - It occupies the space the first page will occupy, so NOTHING MOVES when
 *     the page arrives. A spinner centred on a blank room is replaced by a
 *     full-height sheet, and the whole layout jumps at exactly the moment the
 *     reader starts reading.
 *
 * The blocks are `--paper-edge` on `--paper`: the sheet's own two tones, so the
 * placeholder is unmistakably part of the page rather than a grey card standing
 * in for one. Nothing shimmers — the motion budget in this design system is
 * streaming text, the citation wipe, and Evidence Rail marks, and a pulsing
 * rectangle is not one of them.
 */
export function PageSkeleton({
  /** Unscaled height of the page, in px. A4 at 96dpi is the honest default. */
  height = 1123,
  scale = 1,
}: {
  height?: number;
  scale?: number;
}) {
  return (
    <div
      role="status"
      aria-label="Loading the document"
      style={{ height: height * scale }}
      className="w-full"
    >
      <div className="flex h-full flex-col gap-4 px-8 py-12">
        <div className="h-3 w-[28%] rounded-control bg-paper-edge" />
        <div className="h-5 w-[52%] rounded-control bg-paper-edge" />
        <div className="mt-2 flex flex-col gap-3">
          {Array.from({ length: 12 }, (_, line) => (
            <div
              key={line}
              className="h-3 rounded-control bg-paper-edge"
              style={{ width: line % 4 === 3 ? "62%" : "100%" }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
