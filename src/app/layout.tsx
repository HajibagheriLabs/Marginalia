import type { Metadata } from "next";
import { Public_Sans, Source_Serif_4, JetBrains_Mono } from "next/font/google";
import { Toaster } from "sonner";

import { ThemeProvider } from "@/components/theme-provider";
import { APP_NAME, APP_TAGLINE } from "@/lib/brand";
import { publicEnv } from "@/lib/env.public";

import "./globals.css";

/**
 * Three faces, one sentence of role boundary: chrome / page / numbers.
 * Nothing else may be loaded.
 */

/** All interface text. */
const publicSans = Public_Sans({
  variable: "--font-public-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

/** Document body text inside the paper sheet only. */
const sourceSerif = Source_Serif_4({
  variable: "--font-source-serif",
  subsets: ["latin"],
  weight: ["400", "600"],
  display: "swap",
});

/** Every number and identifier: pages, scores, token counts, latency, ids. */
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
});

export const metadata: Metadata = {
  /**
   * Set HERE rather than on the landing page, even though the landing page is
   * the one with a social card.
   *
   * `metadataBase` is what turns a relative asset path — `/opengraph-image`,
   * `/icon.svg` — into the absolute URL a crawler requires. Next.js resolves it
   * per route, so leaving it on `/` alone makes every OTHER route warn at build
   * time and fall back to guessing `http://localhost:3000`. One base for the
   * whole application is both correct and one place to change.
   *
   * `NEXT_PUBLIC_APP_URL` is validated as a URL at boot, so this cannot be
   * malformed.
   */
  metadataBase: new URL(publicEnv.NEXT_PUBLIC_APP_URL),
  title: {
    default: APP_NAME,
    template: `%s · ${APP_NAME}`,
  },
  description: APP_TAGLINE,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${publicSans.variable} ${sourceSerif.variable} ${jetbrainsMono.variable} h-full`}
      suppressHydrationWarning
    >
      <body className="flex min-h-full flex-col">
        <ThemeProvider>
          {children}
          <Toaster position="bottom-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
