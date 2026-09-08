import type { NextConfig } from "next";

import { securityHeaders } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  /**
   * Packages the server build must require at runtime rather than bundle.
   *
   * `onnxruntime-node` ships prebuilt `.node` binaries and resolves them by
   * path at load time. Bundling it rewrites those paths, and the failure shows
   * up only in a deployed function — as a missing-binding error at the first
   * embed, long after the build reported success. `@huggingface/transformers`
   * is listed with it because it is what pulls the runtime in and does its own
   * conditional resolution of the node vs web backend.
   *
   * `sharp` comes along as a transitive dependency of Transformers.js for image
   * pipelines. Nothing here embeds images, but it is native too, and letting the
   * bundler try to trace it is a build failure for no benefit.
   */
  serverExternalPackages: [
    "@huggingface/transformers",
    "onnxruntime-node",
    "sharp",
  ],

  /**
   * SECURITY HEADERS ON EVERY RESPONSE, INCLUDING STATIC ASSETS.
   *
   * The table itself is in src/lib/security-headers.ts, where it can be read
   * and tested; this is only where it is attached.
   *
   * `/:path*` rather than a narrower matcher on purpose. The proxy in
   * src/proxy.ts deliberately excludes `/api`, `/pdfjs` and static assets from
   * its own matcher, and headers set from there would inherit those holes — the
   * PDF.js worker would be served with no `X-Content-Type-Options`, and the API
   * routes with no CSP. `headers()` runs at the platform edge for every
   * response Next.js produces, which is the coverage a security header needs.
   *
   * Note that a header set HERE can still be overridden per response by a route
   * handler that sets the same key, which is how the document file route
   * tightens `Content-Disposition` and `Cache-Control` for the bytes it serves.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders(),
      },
    ];
  },
};

export default nextConfig;
