import type { MetadataRoute } from "next";

import { publicEnv } from "@/lib/env.public";

/**
 * /sitemap.xml
 *
 * Every page a signed-out visitor can actually read, and nothing else. The
 * workspace is behind auth, `/demo` mints a session rather than serving a page,
 * and the password-reset routes are reachable only from an emailed link — a
 * sitemap entry for any of them would be an entry for a redirect.
 *
 * Priorities are relative and mean only "the landing page is the entry point".
 * `lastModified` is the build time, which is the honest answer for static
 * marketing pages: they change when the deployment changes.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = publicEnv.NEXT_PUBLIC_APP_URL;
  const lastModified = new Date();

  return [
    { url: new URL("/", base).toString(), lastModified, priority: 1 },
    { url: new URL("/sign-in", base).toString(), lastModified, priority: 0.4 },
    { url: new URL("/sign-up", base).toString(), lastModified, priority: 0.4 },
  ];
}
