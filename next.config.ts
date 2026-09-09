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
