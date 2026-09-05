import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendor build output: the PDF.js runtime, copied verbatim out of
    // pdfjs-dist by scripts/copy-pdf-worker.mjs on every build. Linting a
    // minified third-party bundle produces thousands of warnings about code
    // this repository does not own and must not edit.
    "public/pdfjs/**",
  ]),
]);

export default eslintConfig;
