import type { Metadata } from "next";
import Link from "next/link";

import { RetrievalTrace } from "@/components/conversation/retrieval-trace";
import {
  GroundedExhibit,
  RefusalExhibit,
} from "@/components/landing/exhibits";
import { HowItWorks } from "@/components/landing/how-it-works";
import { ProductDemo } from "@/components/landing/product-demo";
import { FeatureSection } from "@/components/landing/section";
import {
  FOOTER,
  HERO,
  META,
  NAV,
  RETRIEVAL_TRACE,
  RETRIEVAL_TRACE_NOTE,
  SECTIONS,
  SHOWCASE,
} from "@/components/landing/copy";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { APP_NAME } from "@/lib/brand";

/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THE PUBLIC LANDING PAGE.                                                 │
 * │                                                                          │
 * │ This file is LAYOUT ONLY. Every sentence, label, and exhibit on the page │
 * │ lives in src/components/landing/copy.ts — see the header of that file    │
 * │ for the house style and for why the exhibits are real.                   │
 * │                                                                          │
 * │ THE ONE PLACE WITH A DISPLAY-SCALE HEADLINE, and it is set in PUBLIC     │
 * │ SANS. The inversion is deliberate and is stated in the type scale: the   │
 * │ serif belongs to documents, so it appears on this page only inside the   │
 * │ paper sheet, where document text lives. A serif marketing headline would │
 * │ borrow the authority of the thing the product is FOR.                    │
 * │                                                                          │
 * │ NO GRADIENTS, NO GLOW, NO FLOATING CARDS, NO ABSTRACT IMAGERY. The only  │
 * │ coloured thing on this page is citrine, and every time it appears it is  │
 * │ a citation — on the sheet as a 26% band with a full-strength underline,  │
 * │ and on the chips that point at the sheet. Chrome is monochrome, and the  │
 * │ two shadows are the two the system has: the sheet is lifted because it   │
 * │ is paper lying on a table, and nothing else on this page is lifted at    │
 * │ all.                                                                     │
 * │                                                                          │
 * │ A SERVER COMPONENT. The only interactive island is `ProductDemo`, plus   │
 * │ the theme toggle and the retrieval trace's own disclosure button.        │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

/**
 * Route metadata, including the Open Graph card.
 *
 * `metadataBase` is NOT here — it is set once in the root layout, so every
 * route resolves relative asset URLs the same way. The `opengraph-image` route
 * beside this file is picked up by convention and needs no reference.
 *
 * The title is written out rather than run through the layout's `%s · Marginalia`
 * template: on the page whose subject IS the product, that template would read
 * "Marginalia · Marginalia".
 */
export const metadata: Metadata = {
  title: {
    absolute: META.title,
  },
  description: META.description,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: APP_NAME,
    title: META.title,
    description: META.description,
  },
  twitter: {
    card: "summary_large_image",
    title: META.title,
    description: META.description,
  },
};

export default function LandingPage() {
  return (
    <div className="flex min-h-full flex-col">
      {/* ---- HEADER: a wordmark and two ways in ---------------------------- */}
      <header className="border-b border-edge">
        <div className="mx-auto flex w-full max-w-[1180px] items-center justify-between gap-4 px-5 py-4 sm:px-8">
          <span className="text-section-title text-text">{APP_NAME}</span>
          <nav className="flex items-center gap-2">
            <ThemeToggle />
            <Button asChild variant="ghost" size="sm">
              <Link href={NAV.signIn.href}>{NAV.signIn.label}</Link>
            </Button>
          </nav>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[1180px] flex-1 flex-col gap-20 px-5 pt-14 pb-20 sm:px-8 sm:pt-20 sm:gap-28">
        {/* ---- HERO ------------------------------------------------------- */}
        <section className="flex flex-col gap-6">
          <h1 className="max-w-[17ch] text-display font-sans text-text">
            {HERO.headline}
          </h1>

          <p className="max-w-[58ch] text-body text-text-muted sm:text-[16px] sm:leading-[1.6]">
            {HERO.subhead}
          </p>

          <div className="flex flex-col gap-3 pt-1">
            <div className="flex flex-wrap items-center gap-3">
              {/* Monochrome, both of them. The primary is a --text fill; the
                  secondary is an outline. Neither is coloured, because on this
                  page colour would mean citation. */}
              <Button asChild size="lg">
                <Link href={HERO.primary.href} prefetch={false}>
                  {HERO.primary.label}
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link href={HERO.secondary.href}>{HERO.secondary.label}</Link>
              </Button>
            </div>
            <p className="text-body-sm text-text-faint">{HERO.note}</p>
          </div>
        </section>

        {/* ---- THE PRODUCT, RENDERED --------------------------------------
            The strongest thing on the page, so it gets the most room: full
            width, its own breathing space, and nothing competing beside it. */}
        <section className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <p className="label">{SHOWCASE.label}</p>
            <p className="max-w-[62ch] text-body-sm text-text-muted">
              {SHOWCASE.caption}
            </p>
          </div>

          <ProductDemo />

          {/* The document the sheet is showing, named in full. A page that
              shows a contract without saying which one is showing a mock-up. */}
          <p className="text-body-sm text-text-faint">
            {SHOWCASE.documentTitle}
          </p>
        </section>

        {/* ---- THREE CLAIMS, ONE HONEST VISUAL EACH ------------------------ */}
        <div className="flex flex-col gap-20 sm:gap-28">
          <FeatureSection {...SECTIONS.grounded}>
            <GroundedExhibit />
          </FeatureSection>

          <FeatureSection {...SECTIONS.hybrid} reverse>
            <div className="flex flex-col gap-2">
              {/* The real component, with static rows and its disclosure open:
                  a collapsed row here would show the reader nothing. */}
              <RetrievalTrace rows={RETRIEVAL_TRACE} defaultOpen />
              <p className="text-mono-xs leading-relaxed text-text-faint">
                {RETRIEVAL_TRACE_NOTE}
              </p>
            </div>
          </FeatureSection>

          <FeatureSection {...SECTIONS.refusal}>
            <RefusalExhibit />
          </FeatureSection>
        </div>

        {/* ---- HOW IT WORKS ------------------------------------------------ */}
        <HowItWorks />
      </main>

      {/* ---- FOOTER -------------------------------------------------------- */}
      <footer className="border-t border-edge">
        <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-4 px-5 py-8 sm:flex-row sm:items-start sm:justify-between sm:px-8">
          <p className="max-w-[58ch] text-body-sm text-text-muted">
            {FOOTER.corpus}
          </p>
          <nav className="flex flex-wrap gap-x-5 gap-y-2">
            {FOOTER.links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                prefetch={false}
                className="focus-ring rounded-control text-body-sm text-text underline underline-offset-4 hover:text-text-muted"
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
      </footer>
    </div>
  );
}
