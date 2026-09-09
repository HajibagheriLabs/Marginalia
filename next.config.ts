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

  /*
   * BISECT IN PROGRESS — `outputFileTracingIncludes` temporarily removed.
   *
   * It is what puts `libonnxruntime.so.1` into the functions that need it (the
   * tracer cannot see it: the native addon dlopens it, so no JavaScript ever
   * names it). Verified correct in the local trace manifest, and the Vercel
   * build compiles fine with it — but the deploy then fails in the "Deploying
   * outputs" phase, and with the previous deployment staying live there is no
   * way from outside to tell which of the two it is.
   *
   * Removing it alone answers that: a green build means this directive is the
   * trigger and its form needs changing; a red build means the failure is
   * somewhere else entirely and this was never the cause. It goes straight back
   * either way — without it, /api/chat and /api/ingest cannot load ONNX.
   */

  /**
   * ┌────────────────────────────────────────────────────────────────────────┐
   * │ WHAT MUST NEVER BE TRACED INTO A FUNCTION.                             │
   * │                                                                        │
   * │ 1. THE LIBRARY'S OWN WEIGHTS CACHE. Transformers.js defaults its cache │
   * │    to `node_modules/@huggingface/transformers/.cache`, and anything    │
   * │    that has ever run a model locally — `npm test`, the eval harness,   │
   * │    the seed — leaves 57 MB of `.onnx` weights sitting there. The       │
   * │    tracer has no idea those are a cache; it sees files inside a        │
   * │    package the function depends on and ships them.                     │
   * │                                                                        │
   * │    Vercel installs fresh, so today that directory is empty there and   │
   * │    the weights are downloaded to /tmp at runtime as intended. Two      │
   * │    things still make this worth excluding: Vercel caches node_modules  │
   * │    between builds, so the day something populates it the functions     │
   * │    grow 57 MB with no diff to explain it — and, more immediately, a    │
   * │    size measured locally is 57 MB wrong, which is exactly the kind of  │
   * │    misleading number you reach for when a deploy fails on size.        │
   * │                                                                        │
   * │ 2. BINARIES FOR PLATFORMS A VERCEL FUNCTION CANNOT EXECUTE. Both       │
   * │    `onnxruntime-node` and `sharp` ship per-platform native code. Only  │
   * │    linux/x64 can ever run here; macOS, Windows and every ARM variant   │
   * │    are pure weight. Excluding them is safe in a way that guessing at   │
   * │    a size budget is not: if one of these were ever needed, the build   │
   * │    would fail loudly rather than ship something subtly wrong.          │
   * └────────────────────────────────────────────────────────────────────────┘
   */
  outputFileTracingExcludes: {
    "**": [
      // A developer machine's downloaded weights. Runtime fetches to /tmp.
      "./node_modules/@huggingface/transformers/.cache/**",
      // ONNX Runtime for platforms a function cannot execute.
      "./node_modules/onnxruntime-node/bin/napi-v6/darwin/**",
      "./node_modules/onnxruntime-node/bin/napi-v6/win32/**",
      "./node_modules/onnxruntime-node/bin/napi-v6/linux/arm64/**",
      // sharp, likewise. It is imported by Transformers.js and never called.
      "./node_modules/**/@img/sharp-darwin-*/**",
      "./node_modules/**/@img/sharp-win32-*/**",
      "./node_modules/**/@img/sharp-linuxmusl-*/**",
      "./node_modules/**/@img/sharp-linux-arm*/**",
      "./node_modules/**/@img/sharp-linux-ppc64/**",
      "./node_modules/**/@img/sharp-linux-riscv64/**",
      "./node_modules/**/@img/sharp-linux-s390x/**",
      "./node_modules/**/@img/sharp-libvips-darwin-*/**",
      "./node_modules/**/@img/sharp-libvips-linuxmusl-*/**",
      "./node_modules/**/@img/sharp-libvips-linux-arm*/**",
      "./node_modules/**/@img/sharp-libvips-linux-ppc64/**",
      "./node_modules/**/@img/sharp-libvips-linux-riscv64/**",
      "./node_modules/**/@img/sharp-libvips-linux-s390x/**",
      "./node_modules/**/@img/sharp-wasm32/**",
      "./node_modules/**/@img/sharp-webcontainers-wasm32/**",
      "./node_modules/**/@img/sharp-freebsd-wasm32/**",
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
