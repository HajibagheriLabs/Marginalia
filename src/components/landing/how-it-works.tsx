import { HOW_IT_WORKS } from "./copy";

/**
 * THE PIPELINE, AS SIX LABELS.
 *
 * The ONE numbered sequence on the page. Numbering is reserved for it because
 * here the order is load-bearing — a chunk cannot be embedded before it is cut,
 * and nothing can be cited before it is retrieved. Numbering the three feature
 * sections as well would turn a real sequence into a decoration and make this
 * one stop meaning anything.
 *
 * The connector is a 1px `--edge` hairline, which is the only kind of divider
 * the design system has. It runs BETWEEN the steps rather than through them, and
 * it is `aria-hidden`: the sequence is already carried by the ordered list, so
 * reading a decoration out would only add noise.
 *
 * On narrow screens the row becomes a column and the connectors disappear
 * entirely rather than rotating — a vertical hairline between stacked cards is a
 * different figure, and the numbers already carry the order.
 */
export function HowItWorks() {
  return (
    <section className="flex flex-col gap-6">
      <p className="label">{HOW_IT_WORKS.label}</p>

      <ol className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-6 lg:gap-x-0">
        {HOW_IT_WORKS.steps.map((step, index) => (
          <li key={step.name} className="relative flex flex-col gap-1.5 lg:pr-6">
            <span className="num text-mono-xs text-text-faint">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span className="text-section-title text-text">{step.name}</span>
            <span className="text-body-sm text-text-muted">{step.detail}</span>

            {/* The connector: a hairline from beside this step's number across
                the gap to the next one. Drawn only at the width where all six
                steps share one row — below that the grid wraps, and a line
                running off the end of a row would point at nothing. */}
            {index < HOW_IT_WORKS.steps.length - 1 ? (
              <span
                aria-hidden
                className="absolute top-[8px] right-0 left-8 hidden h-px bg-edge-strong lg:block"
              />
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
