import { DEMO_USER_EMAIL } from "@/lib/demo";

import { currentLibrary, LIBRARY, seedConversations } from "./seed-main";

/**
 * RESET THE DEMO, cheaply.
 *
 * The demo account is shared and anyone can ask it questions, so its
 * conversation list grows forever: a visitor's half-finished thread about
 * something irrelevant sits above the seeded ones, and the next visitor lands
 * on a workspace that looks abandoned rather than prepared.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT THIS DELETES, AND WHAT IT DELIBERATELY DOES NOT
 *
 * DELETED: every conversation the demo user owns, and — by cascade — its
 * messages, citations, and retrieval traces. That includes the seeded threads,
 * which are then rebuilt by asking their questions again for real.
 *
 * KEPT: the documents, their pages, their chunks, and their vectors. Those are
 * the expensive part — several minutes of local embedding — and nothing a
 * visitor can do touches them, because the demo account cannot upload and
 * cannot delete. Re-ingesting on every reset would make this a job you avoid
 * running, and a reset you avoid running is a demo that stays broken.
 *
 * So this is safe to run on a schedule. It costs one delete plus twelve real
 * model calls, which is a couple of minutes.
 *
 * To rebuild the corpus as well — after a chunk-budget change, say — use
 * `npm run db:seed -- --force` instead.
 */

async function main(): Promise<void> {
  console.log("");
  console.log("resetting the demo workspace");

  const library = await currentLibrary();

  if (library.size === 0) {
    // Rebuilding conversations against an empty library would produce four
    // threads of refusals, which looks exactly like a broken demo. Say what to
    // run instead.
    throw new Error(
      "the demo user has no ready documents — run `npm run db:seed` first, " +
        "which ingests the corpus as well as seeding the conversations.",
    );
  }

  if (library.size < LIBRARY.length) {
    console.log(
      `  ! only ${library.size} of ${LIBRARY.length} documents are ready; ` +
        "run `npm run db:seed` to ingest the rest",
    );
  }

  const result = await seedConversations(library);

  console.log("");
  console.log(
    `  ${library.size} documents kept · ${result.answered}/${result.asked} questions re-answered`,
  );

  if (result.failed.length > 0) {
    console.log("");
    console.log("  NOT ANSWERED — re-run this script to retry:");
    for (const line of result.failed) console.log(`    ${line}`);
    console.log("");
    console.log(
      "  The free model pool is shared and rate-limits under load, so a partial\n" +
        "  reset is routine. The threads that did answer are complete.",
    );
  }

  console.log("");
  console.log(`  demo restored — sign in at /demo, or as ${DEMO_USER_EMAIL}`);
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("");
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
