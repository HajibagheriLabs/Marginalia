import { cn } from "@/lib/utils";

/**
 * One of the three claims on the landing page: a label, a heading, two
 * sentences, and one honest visual.
 *
 * The visual is passed in rather than described, because in every case it is a
 * real component from the application holding static data. The layout alternates
 * sides down the page — `reverse` — so three sections do not read as three
 * copies of the same block.
 *
 * Chrome only: no colour anywhere in this file. The only coloured thing that can
 * appear in a section is whatever the exhibit puts there, and in every case that
 * is a citation.
 */
export function FeatureSection({
  label,
  heading,
  body,
  reverse = false,
  children,
}: {
  label: string;
  heading: string;
  body: readonly string[];
  /** Put the exhibit on the left. Used on the middle section of the three. */
  reverse?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="grid items-center gap-8 lg:grid-cols-2 lg:gap-14">
      <div className={cn("flex flex-col gap-4", reverse && "lg:order-2")}>
        <p className="label">{label}</p>
        <h2 className="max-w-[20ch] text-page-title text-text sm:text-[26px] sm:leading-[1.25]">
          {heading}
        </h2>
        <div className="flex max-w-[46ch] flex-col gap-3">
          {body.map((paragraph) => (
            <p key={paragraph} className="text-body text-text-muted">
              {paragraph}
            </p>
          ))}
        </div>
      </div>

      <div className={cn("min-w-0", reverse && "lg:order-1")}>{children}</div>
    </section>
  );
}
