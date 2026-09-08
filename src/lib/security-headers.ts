/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ RESPONSE SECURITY HEADERS, INCLUDING THE CONTENT SECURITY POLICY.        │
 * │                                                                          │
 * │ One file, exported as data rather than applied here, because the same    │
 * │ table has to be readable by three audiences: `next.config.ts`, which     │
 * │ actually sends it; a test, which asserts the directives that matter; and │
 * │ a person deciding whether this deployment is safe to put on the          │
 * │ internet. A policy assembled inline in a config file is a policy nobody  │
 * │ reviews.                                                                 │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

/**
 * Hosts the BROWSER talks to that are not this origin.
 *
 * Exactly one service: Vercel Blob, and only on the upload leg. File bytes go
 * browser → Blob directly because a Vercel function has a hard 4.5 MB request
 * body limit (see src/app/api/blob/upload/route.ts), so `connect-src` has to
 * allow it or every upload fails with a console message and no server-side
 * trace at all.
 *
 * `vercel.com` is the Blob API the client SDK calls to begin an upload;
 * `*.blob.vercel-storage.com` is the store itself, which multipart uploads
 * address directly.
 *
 * READS DO NOT APPEAR HERE, deliberately. The store is configured for private
 * access and a stored file is served back through
 * /api/documents/[documentId]/file, on this origin, behind the same ownership
 * check as everything else. That is what keeps this list to the upload leg.
 */
const BLOB_UPLOAD_ORIGINS = [
  "https://vercel.com",
  "https://*.blob.vercel-storage.com",
];

/**
 * Build the Content Security Policy.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE ONE LOOSE DIRECTIVE, NAMED HONESTLY
 *
 * `script-src` carries `'unsafe-inline'`. That is not an oversight; it is a
 * decision with a reason and a cost, and it is the first thing a reviewer
 * should challenge.
 *
 * Next.js's App Router boots by inlining the RSC flight payload into
 * `<script>self.__next_f.push(...)</script>` tags, and next-themes writes the
 * stored theme onto `<html>` from an inline script before first paint — which
 * is what stops the page flashing the wrong theme on every load. Both are
 * inline scripts in the document.
 *
 * The strict alternative is a per-request nonce, generated in the proxy and
 * echoed into the policy. It works, and it costs static rendering: a nonce is a
 * property of a request, so a page carrying one cannot be prerendered. Every
 * route would become a function invocation, including the marketing page at
 * `/`, which is a server component today with nothing per-request in it.
 *
 * WHAT MAKES THE TRADE DEFENSIBLE: there is no HTML injection surface for
 * `'unsafe-inline'` to protect. Model output is parsed into a token tree and
 * rendered as React elements, never as markup (src/lib/chat/markdown.ts); link
 * hrefs pass a scheme allowlist; and the single place in the application where
 * a string becomes `innerHTML` — the PDF text layer's search highlighting —
 * escapes every interpolation (src/components/viewer/pdf-pages.tsx).
 * `'unsafe-inline'` is the second line of a defence whose first line is
 * "nothing in this application writes markup".
 *
 * The directives that DO close live gaps are all tight: `object-src 'none'`
 * removes plugin-based execution, `base-uri 'self'` stops a `<base>` tag
 * redirecting every relative URL on the page, `form-action 'self'` stops a form
 * posting credentials somewhere else, and `frame-ancestors 'none'` is
 * clickjacking protection that `X-Frame-Options` only approximates.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE DIRECTIVES PDF.js NEEDS, AND WHY THEY BREAK QUIETLY WITHOUT THEM
 *
 * This is the part of a CSP that usually breaks a document viewer, and it
 * breaks with a console message rather than a visible failure:
 *
 *   worker-src 'self' blob: — PDF.js parses and rasterises in a Web Worker.
 *     The worker script is same-origin (public/pdfjs/), but PDF.js also
 *     constructs workers from blob: URLs, and a blocked worker silently drops
 *     it into main-thread "fake worker" mode, which locks the tab on anything
 *     longer than a few pages.
 *   img-src ... blob: data: — rendered pages and extracted images become blob:
 *     and data: URLs.
 *   child-src 'self' blob: — the pre-CSP3 fallback for worker-src, for engines
 *     that do not implement it. Ignored where worker-src is honoured.
 *
 * `'unsafe-eval'` is NOT granted in production. PDF.js compiles font programs
 * with `eval` when it is available and falls back cleanly when it is not — see
 * `isEvalSupported: false` in src/lib/viewer/pdf-worker.ts, which makes that
 * fallback the configured behaviour rather than an accident of this policy.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * DEVELOPMENT
 *
 * `next dev` with Turbopack needs `'unsafe-eval'` for hot module replacement,
 * and the dev overlay opens a websocket. Both are added ONLY outside
 * production, so what runs locally is otherwise the same policy that ships — a
 * CSP that is only enabled in production is a CSP nobody has tested.
 */
export function contentSecurityPolicy(
  isProduction: boolean = process.env.NODE_ENV === "production",
): string {
  const scriptSrc = ["'self'", "'unsafe-inline'"];
  const connectSrc = ["'self'", ...BLOB_UPLOAD_ORIGINS];

  if (!isProduction) {
    // Turbopack's HMR runtime evaluates modules; the dev overlay opens a socket.
    scriptSrc.push("'unsafe-eval'");
    connectSrc.push("ws:", "wss:");
  }

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": scriptSrc,
    // React writes `style` attributes, which CSP counts as inline styles.
    "style-src": ["'self'", "'unsafe-inline'"],
    // Fonts are self-hosted by `next/font`; `data:` covers PDF.js's embedded
    // font programs.
    "font-src": ["'self'", "data:"],
    "img-src": ["'self'", "blob:", "data:"],
    "media-src": ["'none'"],
    "connect-src": connectSrc,
    "worker-src": ["'self'", "blob:"],
    "child-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    // No plugins, no <embed>, no <object>. Nothing here uses them, and they
    // are an execution path a CSP can close outright.
    "object-src": ["'none'"],
    // Nothing here is framed, and nothing here frames anything.
    "frame-src": ["'none'"],
    "frame-ancestors": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
  };

  const serialized = Object.entries(directives).map(
    ([name, values]) => `${name} ${values.join(" ")}`,
  );

  if (isProduction) {
    // A valueless directive. Production only: it would break http://localhost.
    serialized.push("upgrade-insecure-requests");
  }

  return serialized.join("; ");
}

export interface SecurityHeader {
  key: string;
  value: string;
}

/**
 * Every security header this application sends, on every route.
 *
 * HSTS is the one header here that can lock a domain out of plain HTTP for two
 * years, so it is worth stating what it does: it tells the browser never to
 * speak http to this host again, `includeSubDomains` extends that to every
 * subdomain, and `preload` opts into the browser-shipped preload list. It is
 * emitted unconditionally because browsers IGNORE it over plain http — so it is
 * inert in local development and active the moment the site is served over TLS,
 * which is exactly the behaviour wanted.
 *
 * `X-Frame-Options` duplicates `frame-ancestors 'none'` for engines predating
 * CSP level 2. Where both are understood, `frame-ancestors` wins.
 */
export function securityHeaders(
  isProduction: boolean = process.env.NODE_ENV === "production",
): SecurityHeader[] {
  return [
    {
      key: "Content-Security-Policy",
      value: contentSecurityPolicy(isProduction),
    },
    {
      key: "Strict-Transport-Security",
      value: "max-age=63072000; includeSubDomains; preload",
    },
    // No MIME sniffing. This is what makes the Content-Type on
    // /api/documents/[documentId]/file a promise rather than a suggestion.
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    /*
     * Send the full URL to ourselves, the origin to anyone else, and nothing at
     * all when downgrading to http.
     *
     * It matters more here than on a typical site: a workspace URL carries a
     * document id and a conversation id. `strict-origin-when-cross-origin` is
     * the default in every current engine, but a default is not a guarantee and
     * stating it costs one header.
     */
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    /*
     * Nothing in this application uses a camera, a microphone, a location, or a
     * payment handler, so each is denied outright rather than left at the
     * browser's default. `interest-cohort=()` opts out of topic-based ad
     * interest grouping; it is a no-op in engines that never shipped it.
     */
    {
      key: "Permissions-Policy",
      value: [
        "accelerometer=()",
        "autoplay=()",
        "camera=()",
        "display-capture=()",
        "encrypted-media=()",
        "fullscreen=(self)",
        "geolocation=()",
        "gyroscope=()",
        "interest-cohort=()",
        "magnetometer=()",
        "microphone=()",
        "midi=()",
        "payment=()",
        "usb=()",
      ].join(", "),
    },
    /*
     * Cross-origin isolation, at the level this application can sustain.
     * `same-origin` on the opener policy severs the `window.opener`
     * relationship with any page that opened this one; `same-site` on the
     * resource policy stops another site embedding our responses as a
     * subresource.
     *
     * NOT `require-corp` on an embedder policy: that would demand a CORP or
     * CORS header on every subresource, and there is no cross-origin
     * subresource here to benefit from it.
     */
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "Cross-Origin-Resource-Policy", value: "same-site" },
  ];
}
