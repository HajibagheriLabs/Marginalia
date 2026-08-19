"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * The workspace is a dark room by default. `next-themes` writes `light` or
 * `dark` onto <html>, which is what the ROOM token blocks in globals.css key
 * off; PAPER tokens are declared outside those blocks and never change.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
