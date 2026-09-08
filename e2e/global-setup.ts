import { randomUUID } from "node:crypto";
import path from "node:path";

import type { FullConfig } from "@playwright/test";

import { loadEnvFile } from "../src/lib/env.file";
import { buildE2ePdf, E2E_DOCUMENT } from "./support/fixture";
import {
  FIXTURE_PORT,
  MODEL_STUB_PORT,
  startFixtureServer,
  startModelStub,
} from "./support/model-stub";

/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ WHAT THE BROWSER SUITE NEEDS BEFORE IT CAN OPEN A PAGE.                  │
 * │                                                                          │
 * │   1. A MODEL STUB, so the answer is deterministic and free. See          │
 * │      support/model-stub.ts for why the seam is the socket rather than    │
 * │      the AI SDK.                                                         │
 * │   2. A FILE SERVER for the fixture PDF, standing in for Vercel Blob.     │
 * │      Extraction fetches `documents.blob_url` and does not care who is    │
 * │      serving it, so the pipeline runs for real against real PDF bytes.   │
 * │   3. A USER, created through the REAL sign-up endpoint. Inserting a row  │
 * │      with a hand-made password hash would let the suite pass while the   │
 * │      credential path was broken, which is half of what it is testing.    │
 * │   4. A DOCUMENT, ingested through the REAL four-stage pipeline.          │
 * │                                                                          │
 * │ WHAT IS DELIBERATELY NOT HERE: the browser file-picker leg of upload.    │
 * │ That posts bytes straight to Vercel Blob from the client with a          │
 * │ short-lived token, so exercising it needs a real Blob token — a secret   │
 * │ CI does not have and should not need. The rest of the path after the     │
 * │ bytes land is what runs below, unchanged. See the README's testing       │
 * │ section for the full list of what is and is not covered.                 │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

export interface E2EContext {
  email: string;
  password: string;
  documentId: string;
  userId: string;
}

/**
 * Written to disk rather than passed in memory: Playwright runs global setup in
 * its own process, and the spec files cannot see its variables.
 */
export const CONTEXT_PATH = path.join(process.cwd(), "e2e", ".context.json");

export default async function globalSetup(config: FullConfig) {
  loadEnvFile(path.join(process.cwd(), ".env.local"));

  const baseURL = config.projects[0]?.use?.baseURL ?? "http://127.0.0.1:3000";

  const fixtures = await startFixtureServer(FIXTURE_PORT, {
    [E2E_DOCUMENT.filename]: {
      body: buildE2ePdf(),
      contentType: "application/pdf",
    },
  });

  const model = await startModelStub(MODEL_STUB_PORT);

  const email = `e2e-${randomUUID()}@example.test`;
  const password = `e2e-${randomUUID()}`;

  /*
   * THE REAL SIGN-UP ENDPOINT. Better Auth hashes the password, creates the
   * account row, and mints a session exactly as the form does. A direct insert
   * would be faster and would test nothing about whether sign-in works.
   */
  const signUp = await fetch(`${baseURL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Better Auth rejects a request with no Origin as CSRF — which a browser
      // would always send and `fetch` from Node never does. Supplying it is not
      // weakening the check: the value has to match the configured
      // BETTER_AUTH_URL, which is exactly what the check is for.
      Origin: baseURL,
    },
    body: JSON.stringify({ email, password, name: "E2E" }),
  });

  if (!signUp.ok) {
    throw new Error(
      `E2E sign-up failed (${signUp.status}): ${await signUp.text()}`,
    );
  }

  // Imported lazily so the env file is loaded before `src/lib/env.ts` parses.
  const { db } = await import("../src/db");
  // The leaf modules rather than the `export *` barrel: Playwright transpiles
  // these to CJS, and a re-export star does not survive a dynamic import
  // intact — the binding arrives undefined with no error until it is read.
  const { users } = await import("../src/db/schema/auth");
  const { documents } = await import("../src/db/schema/documents");
  const { eq } = await import("drizzle-orm");
  const { runPipeline } = await import("../src/lib/ingest/pipeline");

  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!user) throw new Error("E2E user was not created");

  /*
   * CONFIRM THE ADDRESS DIRECTLY.
   *
   * Sign-in requires a verified email, and verification arrives by a link in an
   * email that no provider is configured to send — the address is
   * `@example.test` and nothing would deliver it anyway. Flipping the flag is
   * the honest shortcut: the E2E is asserting the CREDENTIAL path (the hash
   * Better Auth wrote at sign-up is the one it checks at sign-in), and the
   * mail round trip is a different feature with a different failure mode.
   *
   * Note what is NOT shortcut: the password was never handled by this file. It
   * was hashed by the real sign-up endpoint and is verified by the real sign-in
   * form, which is why a broken credential path still fails this suite.
   */
  await db
    .update(users)
    .set({ emailVerified: true })
    .where(eq(users.id, user.id));

  /*
   * REAL PDF PARSING, WITHOUT VERCEL BLOB.
   *
   * `runExtraction` reads the file through the Blob SDK, which validates that
   * the URL belongs to a Blob store — so a locally served file cannot reach it,
   * and CI has no Blob token. What matters for this suite is not the transfer
   * but the PARSE, so `extractDocument` is called directly with the fixture's
   * bytes. That is the same function the stage calls, on a genuine PDF, through
   * PDF.js: pages, text and character offsets are all produced by production
   * code.
   *
   * The three stages that follow — chunk, embed, index — then run through the
   * real `runPipeline`, unchanged.
   */
  const pdf = buildE2ePdf();
  const { extractDocument } = await import("../src/lib/ingest/extract");
  const { documentPages } = await import("../src/db/schema/documents");

  const extracted = await extractDocument({
    data: new Uint8Array(pdf),
    filename: E2E_DOCUMENT.filename,
    mimeType: "application/pdf",
  });

  const [document] = await db
    .insert(documents)
    .values({
      userId: user.id,
      title: E2E_DOCUMENT.title,
      filename: E2E_DOCUMENT.filename,
      mimeType: "application/pdf",
      byteSize: pdf.byteLength,
      // Where the Blob URL would be. Nothing after extraction reads it, and
      // the reading pane only needs it for the "download original" link.
      blobUrl: `${fixtures.url}/${E2E_DOCUMENT.filename}`,
      blobPathname: `${user.id}/${E2E_DOCUMENT.filename}`,
      pageCount: extracted.pageCount,
      // Extraction has run; the pipeline picks up at the next stage.
      status: "chunking",
    })
    .returning({ id: documents.id });

  await db.insert(documentPages).values(
    extracted.pages.map((page) => ({
      documentId: document.id,
      pageNumber: page.pageNumber,
      text: page.text,
      charStart: page.charStart,
      charEnd: page.charEnd,
    })),
  );

  /*
   * chunk → embed → index, through the real orchestrator: the same three
   * runners the upload action drives, in the same order, with the same
   * idempotence. Run here rather than through `/api/ingest` so a failure is a
   * setup error with a stack instead of a document that quietly sits at
   * `failed` while the browser test waits for `ready` and times out.
   */
  await runPipeline(document.id, user.id);

  const [ingested] = await db
    .select({ status: documents.status, error: documents.errorMessage })
    .from(documents)
    .where(eq(documents.id, document.id))
    .limit(1);

  if (ingested?.status !== "ready") {
    throw new Error(
      `E2E fixture did not reach ready (status ${ingested?.status}): ${ingested?.error}`,
    );
  }

  const context: E2EContext = {
    email,
    password,
    documentId: document.id,
    userId: user.id,
  };

  const { writeFile } = await import("node:fs/promises");
  await writeFile(CONTEXT_PATH, JSON.stringify(context, null, 2));

  // Teardown closes both servers; the model stub has to outlive setup because
  // the app calls it during the tests.
  return async () => {
    await model.close();
    await fixtures.close();
    await db.delete(users).where(eq(users.id, user.id));
  };
}
