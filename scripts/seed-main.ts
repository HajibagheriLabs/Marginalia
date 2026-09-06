import { readFile } from "node:fs/promises";
import path from "node:path";

import { hashPassword } from "better-auth/crypto";
import { and, eq, isNull } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { db } from "@/db";
import { accounts, conversations, documents, messages, users } from "@/db/schema";
import {
  DEMO_USER_EMAIL,
  DEMO_USER_ID,
  DEMO_USER_NAME,
} from "@/lib/demo";
import { env } from "@/lib/env";
import { ingestTextDocument } from "@/lib/ingest/seed-text";
import { answer } from "@/lib/llm";
import { getVectorStore } from "@/lib/vector";

/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THE DEMO SEED.                                                           │
 * │                                                                          │
 * │   demo user  →  four documents, ingested for real  →  four conversations │
 * │                                                        with real answers │
 * │                                                                          │
 * │ REAL, NOT FIXTURES. The documents go through the shipping chunking,      │
 * │ embedding, and indexing stages into real Postgres rows and real Qdrant   │
 * │ points, and the seeded answers are produced by calling the shipping      │
 * │ `answer()` — same retrieval, same prompt, same model pool, same citation │
 * │ validation, same rows. A demo built from canned JSON would show a        │
 * │ picture of the product; this one shows the product.                      │
 * │                                                                          │
 * │ The visible consequence is the point: a visitor landing on /demo sees an │
 * │ Evidence Rail already marked up with the passages those answers cited,   │
 * │ before they have typed anything. That is the element the application is  │
 * │ remembered by, and it cannot be faked into existence — a tick mark on    │
 * │ the rail is a citation row pointing at a chunk with real offsets.        │
 * │                                                                          │
 * │ IDEMPOTENT. Re-running does not duplicate anything: the user is upserted │
 * │ by its fixed id, documents are skipped when the library already matches  │
 * │ the manifest, and conversations are rebuilt from scratch rather than     │
 * │ appended to. `--force` re-ingests, `--conversations-only` skips straight │
 * │ to the expensive-but-fast half.                                          │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

const DATASET_DIR = path.join(process.cwd(), "evals", "dataset");

/**
 * The seeded library, and the conversation that ships with each document.
 *
 * The questions are chosen to demonstrate different retrieval behaviours
 * rather than to be uniformly easy — see the note on each. Every one of them
 * has been checked against the committed text, so a seed that produces a
 * refusal here means retrieval regressed, not that the question was wrong.
 */
interface SeedDocument {
  filename: string;
  title: string;
  /** The conversation's title in the rail. */
  thread: string;
  questions: string[];
}

const LIBRARY: SeedDocument[] = [
  {
    filename: "hipaa-45-cfr-164.txt",
    title: "45 CFR Part 164 — Security and Privacy (HIPAA)",
    thread: "Breach notification deadlines",
    questions: [
      // A precise deadline stated once, in one clause. The clean case.
      "How long does a covered entity have to notify individuals after discovering a breach?",
      // A different 60-day clock in the same part. Retrieval that returns the
      // first one instead produces an answer that reads correct and is not.
      "How are breaches affecting fewer than 500 individuals reported to the Secretary?",
      /*
       * "Required" vs "Addressable" is the distinction the whole Security Rule
       * turns on, and both words sit in the same passage.
       *
       * PHRASED THE WAY THE EVAL SET PHRASES IT, deliberately. An earlier
       * wording — "Is encrypting electronic PHI in transit required or
       * addressable?" — retrieved the definition of "encryption" and the
       * organisational-safeguards clause instead of § 164.312(e), and the
       * honest answer was a refusal. That is correct behaviour and a bad
       * demonstration: a seeded thread should show the product working, and
       * the refusal is already demonstrated on purpose by the third suggested
       * question in the composer.
       *
       * This wording is measured: it is `hipaa-transmission-encryption` in
       * evals/questions.jsonl, which retrieves at rank 1.
       */
      "Does the Security Rule require encrypting electronic PHI in transit?",
    ],
  },
  {
    filename: "nist-sp-800-63b.txt",
    title:
      "NIST SP 800-63B — Digital Identity Guidelines: Authentication and Lifecycle Management",
    thread: "Authenticator requirements by assurance level",
    questions: [
      // The answer lives in a TABLE ROW. This is the question that shows the
      // corpus converter kept tables instead of dropping them.
      "Which authenticator types are permitted at AAL2?",
      // Prose, and famously counter-intuitive: the standard argues against
      // composition rules and forced rotation.
      "What does the guideline say about requiring periodic password changes?",
      "What is the minimum length for a memorized secret chosen by a subscriber?",
    ],
  },
  {
    filename: "far-52-212-4.txt",
    title:
      "FAR 52.212-4 — Contract Terms and Conditions, Commercial Products and Commercial Services",
    thread: "Termination and risk",
    questions: [
      "What is the contractor paid if the Government terminates for convenience?",
      // A single sentence. Short clauses are where the lexical channel earns
      // its place and dense retrieval alone tends not to.
      "When does risk of loss pass to the Government for f.o.b. origin shipments?",
      "What happens if the Government terminates for default and the termination was improper?",
    ],
  },
  {
    filename: "cdc-opioid-guideline-2022.txt",
    title:
      "CDC Clinical Practice Guideline for Prescribing Opioids for Pain — United States, 2022",
    thread: "Dosage thresholds and follow-up",
    questions: [
      "At what total daily opioid dosage should a clinician add extra precautions?",
      "How soon after starting opioid therapy should benefits and risks be reevaluated?",
      // The question says "urine drug testing"; the recommendation says
      // "toxicology testing". A keyword-only system misses this.
      "Does the guideline recommend urine drug testing for patients on long-term opioids?",
    ],
  },
];

function log(line: string): void {
  console.log(line);
}

/* ========================================================================== *
 * THE ACCOUNT
 * ========================================================================== */

/**
 * Create or update the demo account, with its published password.
 *
 * WHY THE ROWS ARE WRITTEN DIRECTLY rather than through `auth.api.signUpEmail`:
 * the user id has to be a known constant. Three things must agree on it without
 * talking to each other — this script, the `/demo` route, and every server-side
 * `isDemoUser` guard — and Better Auth is configured with
 * `generateId: false`, so a sign-up would take whatever `gen_random_uuid()`
 * produced and the constant could not exist.
 *
 * What is NOT hand-rolled is the password. `hashPassword` is Better Auth's own
 * scrypt implementation, imported from `better-auth/crypto`, so the credential
 * this writes is byte-compatible with the one a real sign-up would write and
 * the sign-in path verifies it with no special case. Hand-rolling that would be
 * inventing a second, weaker password format inside an auth system.
 *
 * `emailVerified` is true because the app refuses to issue a session otherwise,
 * and there is no inbox behind demo@marginalia.app to click a link in.
 */
async function ensureDemoUser(password: string): Promise<void> {
  await db
    .insert(users)
    .values({
      id: DEMO_USER_ID,
      name: DEMO_USER_NAME,
      email: DEMO_USER_EMAIL,
      emailVerified: true,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: { name: DEMO_USER_NAME, email: DEMO_USER_EMAIL, emailVerified: true },
    });

  const hash = await hashPassword(password);

  // Better Auth looks up a credential account by (provider_id, account_id),
  // where account_id for the email provider is the user's id.
  const [existing] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, DEMO_USER_ID),
        eq(accounts.providerId, "credential"),
      ),
    )
    .limit(1);

  if (existing) {
    // Rewritten on every seed, so rotating DEMO_USER_PASSWORD in the
    // environment and re-seeding is all it takes to change the published
    // credential.
    await db
      .update(accounts)
      .set({ password: hash })
      .where(eq(accounts.id, existing.id));
    log(`  account: credential updated`);
    return;
  }

  await db.insert(accounts).values({
    userId: DEMO_USER_ID,
    accountId: DEMO_USER_ID,
    providerId: "credential",
    issuer: CREDENTIAL_ISSUER,
    password: hash,
  });
  log(`  account: credential created`);
}

/**
 * Better Auth's synthetic issuer for a local email+password account.
 *
 * `createLocalAccountIssuer("credential")` in @better-auth/core, which is
 * `local:${encodeURIComponent(providerId)}`. It is written out here rather than
 * imported because that package is a transitive dependency nested inside
 * better-auth's own node_modules and is not resolvable from application code.
 *
 * A hard-coded constant copied out of a dependency is exactly the kind of thing
 * that rots silently, so it is not trusted — `verifyDemoSignIn` below proves it
 * by signing in with the credential this script just wrote. If the format ever
 * changes, the seed fails immediately and says so, instead of producing a demo
 * whose front door does not open.
 */
const CREDENTIAL_ISSUER = "local:credential";

/**
 * Prove the seeded credential actually works.
 *
 * Writing auth rows by hand is a shortcut, and the honest way to take a
 * shortcut is to check it. This runs the real sign-in path — the same one
 * `/demo` will use — against the row that was just written. A green seed
 * therefore means "a visitor can get in", not "the insert did not throw".
 */
async function verifyDemoSignIn(password: string): Promise<void> {
  const result = await auth.api
    .signInEmail({ body: { email: DEMO_USER_EMAIL, password } })
    .catch((error: unknown) => {
      throw new Error(
        `the seeded demo credential does not work: ${
          error instanceof Error ? error.message : String(error)
        }. The account row is written by hand (see CREDENTIAL_ISSUER); if Better ` +
          `Auth changed its account shape, that is what to fix.`,
      );
    });

  if (!result?.user || result.user.id !== DEMO_USER_ID) {
    throw new Error(
      "the seeded demo credential signed in as an unexpected user — check for a " +
        "second account row with the same email.",
    );
  }

  log("  account: sign-in verified");
}

/* ========================================================================== *
 * THE LIBRARY
 * ========================================================================== */

/** The demo user's live documents, by filename. */
async function currentLibrary(): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: documents.id, filename: documents.filename, status: documents.status })
    .from(documents)
    .where(and(eq(documents.userId, DEMO_USER_ID), isNull(documents.deletedAt)));

  return new Map(
    rows.filter((row) => row.status === "ready").map((row) => [row.filename, row.id]),
  );
}

/**
 * Ingest every document the demo library is missing.
 *
 * Skips what is already there and ready, so the common re-run costs one query.
 * `force` clears the library first, which is what a chunk-budget change needs:
 * chunk ids are minted fresh, so the old vector points would be orphans.
 */
async function seedLibrary(force: boolean): Promise<Map<string, string>> {
  const store = getVectorStore();
  await store.ensureCollection();

  if (force) {
    log("  library: --force, clearing previous ingest");
    await store.deleteByUser(DEMO_USER_ID);
    await db.delete(documents).where(eq(documents.userId, DEMO_USER_ID));
  }

  let library = await currentLibrary();
  const missing = LIBRARY.filter((doc) => !library.has(doc.filename));

  if (missing.length === 0) {
    log(`  library: ${library.size} documents already ingested`);
    return library;
  }

  for (const doc of missing) {
    const text = await readFile(path.join(DATASET_DIR, doc.filename), "utf8");
    const started = Date.now();

    const result = await ingestTextDocument({
      userId: DEMO_USER_ID,
      title: doc.title,
      filename: doc.filename,
      text,
      deps: {
        vectors: store,
        // A workstation, not a 300-second function.
        deadline: Date.now() + 30 * 60_000,
      },
    });

    log(
      `  library: ${doc.filename} — ${result.pages} blocks, ${result.chunks} passages, ` +
        `${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
  }

  library = await currentLibrary();
  return library;
}

/* ========================================================================== *
 * THE CONVERSATIONS
 * ========================================================================== */

/**
 * Rebuild the seeded conversations, asking every question for real.
 *
 * DELETE-THEN-WRITE, like every idempotent stage in this codebase. Appending
 * would grow the rail on every seed, and matching old threads to new ones would
 * be guesswork; the conversations are derived data with no identity worth
 * preserving. Messages, citations, and retrieval traces all cascade.
 *
 * This deletes VISITOR conversations too, which is exactly what
 * `npm run db:reset-demo` is for — it calls this and nothing else.
 */
async function seedConversations(
  library: Map<string, string>,
): Promise<{ asked: number; answered: number; failed: string[] }> {
  await db.delete(conversations).where(eq(conversations.userId, DEMO_USER_ID));

  let asked = 0;
  let answered = 0;
  const failed: string[] = [];

  // Newest-first in the rail, so seeding in reverse leaves the HIPAA thread —
  // the one /demo lands on — at the top.
  for (const doc of [...LIBRARY].reverse()) {
    const documentId = library.get(doc.filename);
    if (!documentId) {
      failed.push(`${doc.filename}: not in the library, skipped`);
      continue;
    }

    const [conversation] = await db
      .insert(conversations)
      .values({
        userId: DEMO_USER_ID,
        title: doc.thread,
        // Scoped to ONE document, so each thread's Evidence Rail belongs to the
        // sheet beside it and every citation in it is the same ink.
        documentIds: [documentId],
      })
      .returning({ id: conversations.id });

    for (const question of doc.questions) {
      asked += 1;

      // The question row, written the way the chat route writes it — but
      // without the daily-limit guard, which is a rate limit on visitors and
      // has no business throttling the seed.
      await db.insert(messages).values({
        conversationId: conversation.id,
        role: "user",
        content: question,
      });

      let produced = false;
      let failure: string | null = null;

      // The real engine: real retrieval, real prompt, real model pool with real
      // failover, real citation validation, real rows.
      for await (const event of answer({
        userId: DEMO_USER_ID,
        conversationId: conversation.id,
        documentIds: [documentId],
        question,
      })) {
        if (event.type === "done") produced = true;
        if (event.type === "error") failure = event.message;
      }

      if (produced) {
        answered += 1;
        log(`  thread ${doc.thread}: answered "${question.slice(0, 52)}…"`);
      } else {
        failed.push(`${doc.thread}: ${failure ?? "no answer produced"}`);
        log(`  thread ${doc.thread}: FAILED — ${failure ?? "no answer produced"}`);
      }
    }
  }

  return { asked, answered, failed };
}

/* ========================================================================== *
 * ENTRY
 * ========================================================================== */

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const conversationsOnly = process.argv.includes("--conversations-only");

  const password = env.DEMO_USER_PASSWORD;
  if (!password) {
    throw new Error(
      "DEMO_USER_PASSWORD is not set. The demo account needs a password so /demo " +
        "can sign visitors in. Add it to .env.local — it is published credentials, " +
        "not a secret, but it still has to exist.",
    );
  }

  log("");
  log("seeding the demo workspace");

  await ensureDemoUser(password);
  await verifyDemoSignIn(password);

  const library = conversationsOnly ? await currentLibrary() : await seedLibrary(force);
  if (library.size < LIBRARY.length) {
    log(
      `  ! only ${library.size} of ${LIBRARY.length} documents are ready` +
        (conversationsOnly ? " — run without --conversations-only to ingest" : ""),
    );
  }

  const result = await seedConversations(library);

  log("");
  log(`  ${library.size} documents · ${result.answered}/${result.asked} questions answered`);
  if (result.failed.length > 0) {
    log("");
    log("  NOT ANSWERED — re-run `npm run db:seed -- --conversations-only` to retry:");
    for (const line of result.failed) log(`    ${line}`);
    log("");
    log(
      "  The free model pool is shared and rate-limits under load, so a partial\n" +
        "  seed is routine rather than a failure. The conversations that did answer\n" +
        "  are complete and their citations are real.",
    );
  }
  log("");
  log(`  sign in at /demo, or with ${DEMO_USER_EMAIL}`);
  log("");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("");
    console.error(error instanceof Error ? error.message : error);
    if (error instanceof Error && error.stack) console.error(error.stack);
    process.exit(1);
  });

export { LIBRARY, seedConversations, currentLibrary, ensureDemoUser };
export type { SeedDocument };
