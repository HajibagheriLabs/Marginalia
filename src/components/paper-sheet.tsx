import { cn } from "@/lib/utils";

/**
 * THE PAPER SHEET.
 *
 * The workspace is a dark room and this is the lit sheet of paper lying on the
 * table. It carries three things that exist nowhere else:
 *
 *  - the PAPER tokens, which are INVARIANT — identical in the dark room and the
 *    light room. Switching the theme changes the room around the sheet and
 *    leaves the sheet alone. That is the whole conceit: the page is always
 *    paper. The tokens are declared outside every theme block in globals.css so
 *    this cannot be broken by accident.
 *  - `--shadow-sheet`, one of the two shadows in the application. This is the
 *    ONLY lifted content; everything else in the interface is a 1px hairline.
 *  - the serif typography scope. `.paper-body` sets Source Serif 4 at 17px/1.65
 *    on the container, so document text inherits it and interface text never
 *    can — the serif belongs to documents and does not leave the sheet.
 *
 * The 2px radius is deliberate and is the smallest in the system: paper has a
 * cut edge, not a rounded one, but a perfectly square corner reads as a bug.
 */
export function PaperSheet({
  children,
  /**
   * The Evidence Rail — a 12px strip down the right edge spanning the whole
   * document. Passed in rather than built here so the sheet stays a surface.
   */
  rail,
  className,
  /**
   * REPLACES the default margins rather than adding to them.
   *
   * A PDF page carries its own margins, so the viewer sets this to zero and
   * lets the page go edge to edge; padding the sheet as well would frame the
   * page inside the page. Merging instead of replacing would leave the
   * responsive half of the default (`sm:px-12`) in place and reintroduce the
   * frame at every width above the small breakpoint — a bug that only appears
   * on wide screens.
   */
  contentClassName = "px-6 py-10 sm:px-12 sm:py-14",
  ...props
}: React.ComponentProps<"article"> & {
  rail?: React.ReactNode;
  contentClassName?: string;
}) {
  return (
    <article
      className={cn(
        "paper-sheet paper-body relative mx-auto w-full max-w-[720px]",
        className,
      )}
      {...props}
    >
      {/*
        Padding sets the reading measure: 720px of sheet minus 48px of margin on
        each side leaves a ~624px text column, which lands around 65 characters
        at 17px — the middle of the readable range. The measure is set by the
        margins, the way it is on a real page.
      */}
      <div className={cn(contentClassName)}>{children}</div>

      {rail ? (
        <div className="pointer-events-none absolute inset-y-4 right-4 w-3">
          <div className="pointer-events-auto h-full">{rail}</div>
        </div>
      ) : null}
    </article>
  );
}
