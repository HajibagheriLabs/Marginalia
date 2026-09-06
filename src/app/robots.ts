import type { MetadataRoute } from "next";

import { publicEnv } from "@/lib/env.public";

/**
 * /robots.txt
 *
 * The landing page and the two auth pages are the whole public surface. Three
 * things are kept out, each for its own reason:
 *
 *   /demo   MINTS A SESSION. It is a GET that signs the caller in as the shared
 *           demo account and 303s into a conversation, so a crawler walking it
 *           would create sessions and spend the demo's rate-limit bucket. It is
 *           linked from the page as a normal link with prefetch off; excluding
 *           it here is the same decision applied to robots.
 *   /app/   the workspace, behind auth. Every URL under it redirects to sign-in
 *           for an anonymous request, so indexing it produces nothing but a
 *           pile of duplicate sign-in pages.
 *   /api/   route handlers. Never a page.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/app/", "/api/", "/demo"],
    },
    sitemap: new URL("/sitemap.xml", publicEnv.NEXT_PUBLIC_APP_URL).toString(),
    host: publicEnv.NEXT_PUBLIC_APP_URL,
  };
}
