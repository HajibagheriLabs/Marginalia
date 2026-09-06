import { LIMITS } from "./limits";

/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THE DEMO WORKSPACE.                                                      │
 * │                                                                          │
 * │ One published account, pre-loaded with four real documents and four      │
 * │ conversations that already have answers in them, so a visitor who has    │
 * │ never signed up can see the product working before they type anything.   │
 * │                                                                          │
 * │ WHAT IT IS NOT: a read-only tour. Asking questions MUST work. A chat     │
 * │ product whose demo cannot be chatted with demonstrates nothing, and a    │
 * │ visitor who types a question and gets "not available in the demo" learns │
 * │ only that the demo is fake. So the restrictions below are drawn around   │
 * │ the two operations that let one visitor spoil the workspace for the      │
 * │ next — uploading and deleting — and nothing else.                        │
 * │                                                                          │
 * │ THIS FILE IS ISOMORPHIC. No database import, no `env`, so the banner and │
 * │ the composer's example questions read the same constants the server      │
 * │ enforces. As with limits.ts: the client's copy is a courtesy, the        │
 * │ server's is the decision, and every restriction below names where it is  │
 * │ actually enforced.                                                       │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

/**
 * The demo account's user id, fixed rather than random.
 *
 * Fixed because three separate things have to agree on it without talking to
 * each other: the seed script that creates it, the `/demo` route that signs
 * visitors in as it, and every server-side guard that has to answer "is this
 * the demo user?" on a request that carries only a session. Looking it up by
 * email on every request would be a database round trip to learn a constant.
 *
 * It is a valid v4 uuid and belongs to no real person: sign-up mints its own
 * ids from `gen_random_uuid()` and cannot collide with a hand-written one in
 * any practical sense.
 */
export const DEMO_USER_ID = "de300000-0000-4000-8000-000000000001";

/** Matches the seeded account. The password lives in env, never here. */
export const DEMO_USER_EMAIL = "demo@marginalia.app";
export const DEMO_USER_NAME = "Demo visitor";

/** Is this session the shared demo account? The whole guard, in one place. */
export function isDemoUser(userId: string | null | undefined): boolean {
  return userId === DEMO_USER_ID;
}

/**
 * WHAT THE DEMO CANNOT DO, and why each one.
 *
 * Every entry is enforced on the server at the mutation it names. The UI reads
 * the same flags to explain them, and explaining is all the UI does — a hidden
 * button is not a restriction, since the Server Action behind it is a public
 * HTTP endpoint with a generated name.
 */
export const DEMO_RESTRICTIONS = {
  /**
   * NO UPLOADS. The account is shared, so one visitor's upload is in every
   * later visitor's library — and the upload path ends in blob storage and
   * vector points that nobody is going to clean up.
   *
   * Enforced in: the Blob token route (no token is minted) and
   * `registerUploadedDocument` (no row is written even if one were).
   */
  uploads: false,

  /**
   * NO DELETES. The corpus is the demo. One visitor deleting the HIPAA
   * regulation breaks it for everyone until someone runs the reset script.
   *
   * Enforced in: `deleteDocument` and `deleteAllMyData`.
   */
  deletes: false,

  /**
   * A LOWER DAILY QUESTION CAP than a real account.
   *
   * Not a product limit — a shared-quota limit. Every demo visitor draws on
   * the same ~200 free model requests a day, so the cap here is what stops one
   * enthusiastic visitor at 9am from leaving nothing for anyone else. It is
   * still generous enough to hold a real conversation, which is the point of
   * having a demo at all.
   *
   * Enforced in: `insertUserMessageWithinLimit`, via `dailyMessageLimitFor`.
   */
  messagesPerDay: 25,
} as const;

/**
 * The daily question cap for a given account.
 *
 * One function so the demo cap cannot be applied in one place and forgotten in
 * another — the chat route, the settings readout, and the limit dialog all ask
 * this rather than reading `LIMITS.messagesPerDay` directly.
 */
export function dailyMessageLimitFor(userId: string): number {
  return isDemoUser(userId)
    ? DEMO_RESTRICTIONS.messagesPerDay
    : LIMITS.messagesPerDay;
}

/**
 * The banner text. Persistent, `--warn`, and never dismissible.
 *
 * `--warn` is a SYSTEM STATE, which is the one category of colour allowed on
 * chrome — it is amber-orange rather than citrine precisely so it can never be
 * mistaken for a highlighter ink. Being in a shared, resettable workspace is
 * exactly a system state: it is true for the whole session, it changes what
 * the interface can do, and it is not an error.
 *
 * It says what is disabled rather than only that this is a demo, because
 * "You're in the demo" does not tell someone why the Upload button refused.
 */
export const DEMO_BANNER = {
  title: "You're in the demo workspace. Uploads are disabled.",
  detail:
    "Ask anything about the four documents in the library — that part is real. " +
    "The workspace is shared and resets periodically.",
} as const;

/**
 * THE THREE EXAMPLE QUESTIONS in the demo's empty composer.
 *
 * Hard-coded for the demo only. Everywhere else the suggestions are derived
 * from the selected documents' own heading breadcrumbs (see
 * src/lib/chat/suggestions.ts), which is right for a library nobody has seen
 * before — but the demo's library is known in advance, so its examples can be
 * chosen to demonstrate something rather than merely to be answerable.
 *
 * Each one is picked for a different behaviour:
 *
 *   1. A precise fact with one obvious source. Shows a citation resolving to a
 *      single passage, and clicking it scrolling the sheet to that passage.
 *   2. A question whose answer lives in a TABLE. Shows that retrieval reaches
 *      tabular content, which is where most document-QA demos quietly fail.
 *   3. A question the corpus DOES NOT ANSWER. Shows the refusal, which is the
 *      most important behaviour in the product and the one a demo is most
 *      tempted to hide. Anyone can build something that always answers.
 */
export const DEMO_SUGGESTIONS: readonly { question: string; shows: string }[] = [
  {
    question:
      "How long does a covered entity have to notify individuals after discovering a breach?",
    shows: "a precise deadline, cited to the clause that states it",
  },
  {
    question: "Which authenticator types are permitted at AAL2?",
    shows: "an answer retrieved out of a table",
  },
  {
    question: "What is the maximum civil monetary penalty for a HIPAA violation?",
    shows: "an honest refusal — the answer is in a part of the CFR this library does not hold",
  },
] as const;
