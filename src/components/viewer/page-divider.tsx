/**
 * The hairline between two pages, carrying the page number.
 *
 * ABSOLUTELY POSITIONED, into the gap above the page it labels. That is not a
 * layout convenience — it is what keeps the divider out of the virtualiser's
 * height accounting. A divider that took part in flow would add its own height
 * to every page but the first, and the placeholder heights (which come from
 * PDF.js's page viewports, or from measuring the text) would each be a dozen
 * pixels short. Three hundred pages of that is a scrollbar that lies by a
 * screenful.
 *
 * The number is mono, like every number in this application, and reads "Block"
 * rather than "Page" for a format that has no pages — see `unitLabel`.
 */
export function PageDivider({ label }: { label: string }) {
  return (
    <div
      aria-hidden
      className="absolute inset-x-0 -top-3.5 flex items-center gap-3"
    >
      <span className="h-px flex-1 bg-paper-edge" />
      <span className="num text-mono-xs whitespace-nowrap text-paper-text-muted">
        {label}
      </span>
      <span className="h-px flex-1 bg-paper-edge" />
    </div>
  );
}
