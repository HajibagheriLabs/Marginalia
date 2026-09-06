import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { assemblePages, paginateText } from "@/lib/ingest/extract";

import { EVALS_DIR, readDatasetText, readManifest } from "./dataset";
import { normalise } from "./metrics";
import { loadQuestions } from "./questions";

/**
 * `npm run eval:pages` — derive `expected_pages` from `expected_phrases`.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY PAGE NUMBERS ARE NOT TYPED BY HAND
 *
 * Because a hand-typed page number is a second source of truth for something
 * the corpus already knows, and the two diverge silently. Re-fetching an
 * amended regulation shifts every block after the amendment by one; a change
 * to `SYNTHETIC_PAGE_TARGET_CHARS` shifts all of them. Neither produces an
 * error — recall just quietly falls, and it looks like a retrieval regression.
 * That is the worst possible failure for an eval: a number that moves for a
 * reason unrelated to the thing being measured.
 *
 * So the author writes the question and a few VERBATIM phrases, and this tool
 * finds the blocks those phrases are actually on. The phrases are the ground
 * truth — they are quoted from the document and can be checked by eye — and
 * the page numbers are derived from them.
 *
 * It also VERIFIES rather than only filling. Run with no flags and it re-derives
 * every question's pages and reports any that disagree with what is in the
 * file, so a stale question set is a failed command instead of a bad score.
 * `--write` applies the corrections.
 *
 * A phrase that appears nowhere is a hard error. That is nearly always a typo,
 * a smart quote, or a phrase reconstructed from memory rather than copied — and
 * a phrase that matches nothing scores citation support at zero for a system
 * that was working perfectly.
 */

const QUESTIONS_PATH = path.join(EVALS_DIR, "questions.jsonl");

interface Resolution {
  id: string;
  pages: number[];
  /** Phrases that matched nothing anywhere in the named document. */
  missing: string[];
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write");

  const manifest = await readManifest();
  // Lenient: this tool exists to fill `expected_pages`, so it must be able to
  // read the file before that field is populated.
  const { questions } = await loadQuestions({ lenient: true });

  // Block index per document, built once with the same two functions the
  // ingestion path uses — so a block number here is the block number the
  // product would cite.
  const blocks = new Map<string, { pageNumber: number; text: string }[]>();
  for (const document of manifest.documents) {
    const text = await readDatasetText(document);
    const { pages } = assemblePages(paginateText(text));
    blocks.set(
      document.id,
      pages.map((page) => ({
        pageNumber: page.pageNumber,
        text: normalise(page.text),
      })),
    );
  }

  const resolutions: Resolution[] = [];
  const problems: string[] = [];

  for (const question of questions) {
    if (!question.answerable) {
      // Nothing to resolve, and the loader already refuses a non-empty
      // expected_pages on an unanswerable question.
      resolutions.push({ id: question.id, pages: [], missing: [] });
      continue;
    }

    const index = blocks.get(question.document!);
    if (!index) {
      problems.push(
        `${question.id}: names document "${question.document}", which is not in the manifest`,
      );
      continue;
    }

    const pages = new Set<number>();
    const missing: string[] = [];

    for (const phrase of question.expected_phrases) {
      const needle = normalise(phrase);
      const hits = index.filter((block) => block.text.includes(needle));
      if (hits.length === 0) {
        missing.push(phrase);
        continue;
      }
      for (const hit of hits) pages.add(hit.pageNumber);
    }

    if (missing.length > 0) {
      problems.push(
        `${question.id}: ${missing.length} phrase(s) appear nowhere in ${question.document}:\n` +
          missing.map((phrase) => `      "${phrase}"`).join("\n"),
      );
    }

    resolutions.push({
      id: question.id,
      pages: [...pages].sort((a, b) => a - b),
      missing,
    });
  }

  /* ── REPORT ────────────────────────────────────────────────────────────── */
  const byId = new Map(resolutions.map((r) => [r.id, r]));
  const changed: string[] = [];

  for (const question of questions) {
    const resolution = byId.get(question.id);
    if (!resolution) continue;
    const before = JSON.stringify(question.expected_pages);
    const after = JSON.stringify(resolution.pages);
    if (before !== after) {
      changed.push(`  ${question.id.padEnd(34)} ${before} → ${after}`);
    }
  }

  if (problems.length > 0) {
    console.error("\nPHRASES THAT MATCH NOTHING\n");
    for (const problem of problems) console.error(`  ${problem}`);
    console.error(
      "\nEvery expected_phrase must be copied verbatim from the committed text.\n" +
        "Check for smart quotes, en dashes, and non-breaking spaces — the matcher\n" +
        "folds those, but it cannot fold a word that is not there.\n",
    );
    process.exit(1);
  }

  if (changed.length === 0) {
    console.log(`\n${questions.length} questions — every expected_pages is current.\n`);
    return;
  }

  console.log(`\n${changed.length} question(s) need updating:\n`);
  for (const line of changed) console.log(line);

  if (!write) {
    console.log("\nRe-run with --write to apply.\n");
    process.exit(1);
  }

  await applyPages(byId);
  console.log(`\nWritten to ${path.relative(process.cwd(), QUESTIONS_PATH)}.\n`);
}

/**
 * Rewrite the file in place, one line at a time.
 *
 * Line-by-line rather than re-serialising the parsed questions, because the
 * file is hand-maintained: it carries `#` comments and blank lines that group
 * the set by document, and regenerating it from the parsed objects would throw
 * all of that away and reorder every key. A tool that reformats the file it
 * edits is a tool people stop running.
 */
async function applyPages(resolutions: Map<string, Resolution>): Promise<void> {
  const raw = await readFile(QUESTIONS_PATH, "utf8");

  const updated = raw
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;

      const parsed = JSON.parse(trimmed) as { id: string; expected_pages: number[] };
      const resolution = resolutions.get(parsed.id);
      if (!resolution) return line;

      // A targeted substitution on the raw text, so key order and spacing
      // everywhere else in the row survive untouched.
      return line.replace(
        /"expected_pages":\s*\[[^\]]*\]/,
        `"expected_pages": [${resolution.pages.join(", ")}]`,
      );
    })
    .join("\n");

  await writeFile(QUESTIONS_PATH, updated, "utf8");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
