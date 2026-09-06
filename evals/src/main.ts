import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { getEmbeddingProvider } from "@/lib/embeddings";
import { env } from "@/lib/env";
import { modelPool } from "@/lib/llm/models";

import { fingerprint, parseArgs, usage } from "./config";
import { prepareCorpus } from "./corpus";
import { EVALS_DIR } from "./dataset";
import { computeMetrics } from "./metrics";
import { loadQuestions } from "./questions";
import { renderComparison, renderProgress, renderReport } from "./report";
import {
  createRunConversation,
  deleteRunConversation,
  runQuestion,
} from "./run";
import type { EvalResult, QuestionOutcome } from "./types";

/**
 * `npm run eval` — the whole harness, end to end.
 *
 *   load questions → ingest (cached) → run each question → score → report
 *                                                              → write JSON
 *
 * ───────────────────────────────────────────────────────────────────────────
 * QUESTIONS RUN ONE AT A TIME, AND THAT IS NOT AN OVERSIGHT.
 *
 * Concurrency would make the run several times faster and every latency number
 * in it worthless: the p50 and p95 reported here are supposed to be what one
 * question costs, and questions racing each other for one local embedding
 * pipeline and one shared free-tier model quota measure contention instead.
 * The free pool is ~20 requests a minute across the whole app, so parallel
 * questions would also spend it fast enough to start failing over mid-run and
 * turn a quality measurement into a rate-limit measurement.
 */

const RESULTS_DIR = path.join(EVALS_DIR, "results");

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(usage());
    return;
  }

  if (options.compare) {
    await compare(options.compare[0], options.compare[1]);
    return;
  }

  const startedAt = new Date();
  const log = (line: string): void => console.log(line);

  /* ── LOAD ──────────────────────────────────────────────────────────────── */
  const { questions: allQuestions, digest } = await loadQuestions();

  let questions = allQuestions;
  if (options.filter) {
    questions = questions.filter((q) => q.id.includes(options.filter!));
  }
  if (options.limit !== null) {
    questions = questions.slice(0, options.limit);
  }
  if (questions.length === 0) {
    throw new Error("no questions selected — check --filter / --limit");
  }

  /* ── INGEST ────────────────────────────────────────────────────────────── */
  const corpus = await prepareCorpus(options.config.chunk, {
    force: options.reingest,
    log,
  });

  const provider = getEmbeddingProvider();
  const print = fingerprint({
    config: options.config,
    embeddingModel: provider.model,
    embeddingDimensions: provider.dimensions,
    // The POOL, not the model that happens to serve a given question — that
    // varies per request under failover and is recorded per outcome instead.
    model: options.config.generate ? modelPool()[0] : null,
    corpus: corpus.digests,
    questionSet: digest,
    questionCount: questions.length,
  });

  log("");
  log(
    `running ${questions.length} questions · config ${print.hash}` +
      `${options.config.generate ? "" : " · retrieval only"}`,
  );
  log("");

  /* ── RUN ───────────────────────────────────────────────────────────────── */
  // Created even under --retrieval-only. Nothing writes to it in that mode,
  // but `runQuestion` takes a conversation id unconditionally and a nullable
  // one would put a branch in the hot path to save one row.
  const conversationId = await createRunConversation(corpus);

  const outcomes: QuestionOutcome[] = [];
  const runStartedAt = Date.now();

  try {
    for (const [index, question] of questions.entries()) {
      const outcome = await runQuestion(
        { corpus, config: options.config, conversationId },
        question,
      );
      outcomes.push(outcome);
      log(renderProgress(index, questions.length, outcome));
    }
  } finally {
    // The rows have served their purpose — they proved citation persistence
    // works — and leaving one conversation per run in the database would turn
    // a sweep into hundreds of dead threads under the eval user.
    await deleteRunConversation(conversationId);
  }

  /* ── SCORE AND REPORT ──────────────────────────────────────────────────── */
  const result: EvalResult = {
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - runStartedAt,
    tag: options.tag,
    fingerprint: print,
    metrics: computeMetrics(outcomes),
    outcomes,
  };

  const file = await writeResult(result);
  console.log(renderReport(result, corpus));
  console.log(`  written to ${path.relative(process.cwd(), file)}`);
  console.log("");
}

/* ========================================================================== *
 * RESULT FILES
 * ========================================================================== */

/**
 * `<utc-date>-<hhmmss>-<confighash>[-tag].json`.
 *
 * Date first so the directory sorts chronologically; the config hash in the
 * name so a sweep's files are distinguishable at a glance without opening
 * them; the tag last because it is optional. The time component is what keeps
 * two runs of the SAME config from overwriting each other — which you want,
 * since running one config twice is how you find out how much of a delta is
 * noise.
 */
async function writeResult(result: EvalResult): Promise<string> {
  await mkdir(RESULTS_DIR, { recursive: true });

  const stamp = result.startedAt.replace(/[:.]/g, "").replace("T", "-").slice(0, 15);
  const tag = result.tag ? `-${result.tag.replace(/[^a-zA-Z0-9_-]+/g, "-")}` : "";
  const file = path.join(RESULTS_DIR, `${stamp}-${result.fingerprint.hash}${tag}.json`);

  await writeFile(file, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return file;
}

/**
 * Resolve a `--compare` argument.
 *
 * Accepts a path, a bare filename, or a prefix — including a config hash, so
 * `--compare a1b2c3d4e5f6 9f8e7d6c5b4a` works straight off the report header
 * without anyone having to type a timestamp. An ambiguous prefix names the
 * candidates rather than picking one.
 */
async function resolveResult(reference: string): Promise<EvalResult> {
  const direct = path.resolve(reference);
  try {
    return JSON.parse(await readFile(direct, "utf8")) as EvalResult;
  } catch {
    // Not a path. Fall through to a search.
  }

  const files = (await readdir(RESULTS_DIR)).filter((name) => name.endsWith(".json"));
  const matches = files.filter((name) => name.includes(reference));

  if (matches.length === 0) {
    throw new Error(
      `no result file matches "${reference}". Available:\n${files.map((n) => `  ${n}`).join("\n")}`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `"${reference}" matches ${matches.length} files:\n${matches.map((n) => `  ${n}`).join("\n")}`,
    );
  }

  return JSON.parse(
    await readFile(path.join(RESULTS_DIR, matches[0]), "utf8"),
  ) as EvalResult;
}

async function compare(a: string, b: string): Promise<void> {
  const [left, right] = await Promise.all([resolveResult(a), resolveResult(b)]);
  console.log(renderComparison(left, right));
}

/* ========================================================================== *
 * ENTRY
 * ========================================================================== */

main()
  .then(() => {
    // The Postgres pool holds the process open otherwise. Nothing here is
    // long-lived enough to justify a shutdown hook.
    process.exit(0);
  })
  .catch((error) => {
    console.error("");
    console.error(error instanceof Error ? error.message : error);
    if (error instanceof Error && error.stack && env.NODE_ENV !== "production") {
      console.error(error.stack);
    }
    process.exit(1);
  });
