import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DATASET_DIR,
  MANIFEST_PATH,
  convert,
  readManifest,
  sha256,
  type DatasetDocument,
} from "./dataset";

/**
 * `npm run eval:fetch` — re-download the corpus and check it against the pins.
 *
 * This is a SEPARATE entry point from dataset.ts on purpose. The converters
 * there are imported by the harness, and a module that runs a network fetch as
 * a side effect of being imported is a module that eventually runs one where
 * nobody expected it. An `import.meta.url === argv[1]` guard would work under
 * ESM and silently not work under the CJS transpilation this repo's
 * `package.json` implies — a file with two behaviours depending on how it was
 * loaded. Two files, one behaviour each.
 *
 * Exit code 1 on drift, so CI can fail on it without parsing the output.
 */

async function fetchDocument(document: DatasetDocument): Promise<string> {
  const response = await fetch(document.url, {
    headers: {
      // eCFR's API refuses an uncompressed response outright — a 406 with a
      // message saying so, which looks nothing like a rate limit or a bad URL.
      // Node negotiates this on its own; the header is written out because the
      // failure it prevents is not one you would guess at.
      "accept-encoding": "gzip, deflate",
      accept: "application/xml, text/html;q=0.9, */*;q=0.8",
      // Node's fetch sends no User-Agent at all, and cdc.gov answers a request
      // without one with a 403. Naming the project rather than impersonating a
      // browser: this is a polite, low-volume, occasional fetch of a public
      // document, and the operator is entitled to see what it is.
      "user-agent":
        "marginalia-eval/1.0 (offline retrieval evaluation harness; fetches public-domain source documents)",
    },
  });

  if (!response.ok) {
    throw new Error(
      `${document.id}: ${response.status} ${response.statusText} from ${document.url}`,
    );
  }

  return response.text();
}

async function main(): Promise<void> {
  const update = process.argv.includes("--update");
  const manifest = await readManifest();

  let drifted = 0;
  let pinned = false;

  for (const document of manifest.documents) {
    process.stdout.write(`${document.id} … `);

    const raw = await fetchDocument(document);
    const text = convert(document, raw);
    const digest = sha256(text);
    const target = path.join(DATASET_DIR, document.filename);

    if (document.sha256 === "PENDING" || update) {
      await writeFile(target, text, "utf8");
      document.sha256 = digest;
      pinned = true;
      console.log(
        `written — ${text.length.toLocaleString("en-US")} chars, sha256 ${digest.slice(0, 12)}…`,
      );
      continue;
    }

    if (digest === document.sha256) {
      console.log(`unchanged — ${text.length.toLocaleString("en-US")} chars`);
      continue;
    }

    drifted += 1;
    console.log(
      `DRIFTED — source now hashes ${digest.slice(0, 12)}…, manifest pins ${document.sha256.slice(0, 12)}…`,
    );
  }

  if (pinned) {
    await writeFile(
      MANIFEST_PATH,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
  }

  if (drifted > 0) {
    console.log(
      `\n${drifted} document(s) differ from the pinned corpus. The committed text is\n` +
        `unchanged and the eval still runs against it, so no score has moved. Review\n` +
        `the diff; if the new source text is what you want to measure against, re-run\n` +
        `with --update and expect expected_pages in questions.jsonl to need revisiting.`,
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
