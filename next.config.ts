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
   * ┌────────────────────────────────────────────────────────────────────────┐
   * │ THE SHARED LIBRARY THE FILE TRACER CANNOT SEE.                         │
   * │                                                                        │
   * │ `serverExternalPackages` above keeps `onnxruntime-node` out of the     │
   * │ bundle so its prebuilt `.node` addon is required from node_modules at  │
   * │ runtime. Vercel then decides which files ship with each function by    │
   * │ TRACING module references — and tracing is a static analysis over      │
   * │ JavaScript. It finds `onnxruntime_binding.node`, because JS requires   │
   * │ it by path. It cannot find `libonnxruntime.so.1`, because nothing in   │
   * │ JavaScript ever names it: the addon `dlopen`s it itself, from its own  │
   * │ directory, at load time.                                               │
   * │                                                                        │
   * │ So the addon ships and the library it links against does not, and the  │
   * │ deployed function fails with:                                          │
   * │                                                                        │
   * │     libonnxruntime.so.1: cannot open shared object file                │
   * │                                                                        │
   * │ This is invisible locally in every direction. The file is present in   │
   * │ `node_modules` on a developer machine, so nothing fails; `next build`  │
   * │ succeeds because tracing is not a correctness check; and the only      │
   * │ symptom is a runtime error inside a deployed function.                 │
   * │                                                                        │
   * │ ONLY linux/x64 IS INCLUDED, and the specificity is load-bearing.       │
   * │ `onnxruntime-node` ships every platform's binaries in one tarball —    │
   * │ 211 MB of them — and a `bin/**` glob would put all of it into every    │
   * │ function listed here, past the 250 MB uncompressed limit a Hobby       │
   * │ function has. The Linux x64 directory alone is 34 MB, which is the     │
   * │ only one a Vercel function can execute anyway.                         │
   * │                                                                        │
   * │ WHY THESE THREE KEYS. `/api/chat` embeds the query and reranks;        │
   * │ `/api/ingest` runs the pipeline; and `/app/**` needs it because        │
   * │ `startIngestion` runs the FIRST pipeline pass inline via `after()` in  │
   * │ the upload Server Action's own function, and only continuations go     │
   * │ over HTTP to the route. Omitting the last one would make a small       │
   * │ document — one that finishes in a single pass and never reaches        │
   * │ /api/ingest — the only kind that fails.                                │
   * └────────────────────────────────────────────────────────────────────────┘
   */
  outputFileTracingIncludes: {
    "/api/chat": [
      "./node_modules/onnxruntime-node/bin/napi-v6/linux/x64/**",
    ],
    "/api/ingest": [
      "./node_modules/onnxruntime-node/bin/napi-v6/linux/x64/**",
    ],
    "/app/**": [
      "./node_modules/onnxruntime-node/bin/napi-v6/linux/x64/**",
    ],
  },

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
