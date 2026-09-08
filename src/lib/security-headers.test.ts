import { describe, expect, it } from "vitest";

import { contentSecurityPolicy, securityHeaders } from "./security-headers";

/**
 * THE HEADERS, ASSERTED RATHER THAN EYEBALLED.
 *
 * A security header regresses in exactly one way: someone adds a directive to
 * fix a broken feature and widens one that was doing work. Nothing fails, no
 * page looks different, and the policy is weaker than the comment above it
 * claims. So the tests below are deliberately not a snapshot — a snapshot
 * accepts any change that is committed with it. Each one names a specific
 * property and why losing it would matter.
 */

/** The directives, parsed back out, so assertions can be about VALUES. */
function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split("; ").map((clause) => {
      const [name, ...values] = clause.split(" ");
      return [name, values];
    }),
  );
}

describe("contentSecurityPolicy", () => {
  const production = directives(contentSecurityPolicy(true));

  it("keeps the directives that close live gaps tight", () => {
    // These four are the ones that still do real work alongside an
    // `'unsafe-inline'` script-src, and each closes a different attack:
    // plugin execution, relative-URL hijack via <base>, credential exfil via a
    // redirected form, and clickjacking.
    expect(production.get("object-src")).toEqual(["'none'"]);
    expect(production.get("base-uri")).toEqual(["'self'"]);
    expect(production.get("form-action")).toEqual(["'self'"]);
    expect(production.get("frame-ancestors")).toEqual(["'none'"]);
  });

  it("never grants 'unsafe-eval' in production", () => {
    // Turbopack needs it in development and nothing needs it in production —
    // PDF.js is configured with `isEvalSupported: false` precisely so this can
    // stay closed. See src/lib/viewer/pdf-worker.ts.
    expect(contentSecurityPolicy(true)).not.toContain("'unsafe-eval'");
    expect(contentSecurityPolicy(false)).toContain("'unsafe-eval'");
  });

  it("allows the PDF.js worker and its blob-backed resources", () => {
    // The directive that breaks a document viewer, and breaks it quietly: a
    // blocked worker drops PDF.js into main-thread mode, which locks the tab
    // on a long document rather than throwing anything.
    expect(production.get("worker-src")).toEqual(["'self'", "blob:"]);
    expect(production.get("img-src")).toContain("blob:");
    // The pre-CSP3 fallback for engines that do not implement worker-src.
    expect(production.get("child-src")).toEqual(["'self'", "blob:"]);
  });

  it("allows the blob store only for the upload leg", () => {
    const connect = production.get("connect-src") ?? [];
    expect(connect).toContain("'self'");
    expect(connect).toContain("https://vercel.com");
    expect(connect).toContain("https://*.blob.vercel-storage.com");

    // READS go through /api/documents/[id]/file on this origin. If a public
    // blob host ever appears here it means a document's bytes are being fetched
    // straight from the store again, which is the bug that route exists to fix.
    expect(connect).not.toContain("https://*.public.blob.vercel-storage.com");
  });

  it("does not upgrade insecure requests outside production", () => {
    // It would break http://localhost, and a policy nobody can run locally is
    // a policy nobody tests.
    expect(contentSecurityPolicy(true)).toContain("upgrade-insecure-requests");
    expect(contentSecurityPolicy(false)).not.toContain("upgrade-insecure-requests");
  });
});

describe("securityHeaders", () => {
  const byKey = new Map(
    securityHeaders(true).map((header) => [header.key, header.value]),
  );

  it("sends every header the deployment is expected to carry", () => {
    for (const key of [
      "Content-Security-Policy",
      "Strict-Transport-Security",
      "X-Content-Type-Options",
      "X-Frame-Options",
      "Referrer-Policy",
      "Permissions-Policy",
      "Cross-Origin-Opener-Policy",
      "Cross-Origin-Resource-Policy",
    ]) {
      expect(byKey.has(key)).toBe(true);
    }
  });

  it("sets HSTS for two years, across subdomains, and preloadable", () => {
    // Browsers ignore this over plain http, so it is inert locally and active
    // the moment the site is served over TLS. That is why it is unconditional.
    expect(byKey.get("Strict-Transport-Security")).toBe(
      "max-age=63072000; includeSubDomains; preload",
    );
  });

  it("forbids sniffing, which is what makes a Content-Type a promise", () => {
    expect(byKey.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("denies the powerful features nothing here uses", () => {
    const policy = byKey.get("Permissions-Policy") ?? "";
    for (const feature of ["camera", "microphone", "geolocation", "payment", "usb"]) {
      expect(policy).toContain(`${feature}=()`);
    }
  });
});
