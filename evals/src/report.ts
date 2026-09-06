import type { Corpus } from "./corpus";
import type { EvalResult, QuestionOutcome } from "./types";

/**
 * THE TABLE.
 *
 * Written for a terminal and for a person deciding whether a change helped.
 * Three rules it follows, all of which are about not flattering the run:
 *
 *   - Every rate prints its DENOMINATOR. "recall@5 0.72" invites you to
 *     compare it with someone's benchmark; "recall@5 0.72 (18/25)" reminds you
 *     it is 25 hand-written questions.
 *   - A metric with nothing behind it prints `n/a`, never `0.00`. A zero is a
 *     measurement; an empty denominator is not, and rendering it as 0.00 is
 *     how an eval reports a broken run as a bad one.
 *   - Anything below a target prints a marker. Not colour — a marker, because
 *     the output is as likely to be read in a log as in a terminal.
 */

const BAR = "─".repeat(74);

function pct(value: number | null, digits = 1): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(digits)}%`;
}

function num(value: number, digits = 3): string {
  return value.toFixed(digits);
}

function ms(value: number): string {
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

export function renderReport(result: EvalResult, corpus: Corpus | null): string {
  const { metrics: m, fingerprint: f } = result;
  const out: string[] = [];

  const row = (label: string, value: string, detail = "", flag = ""): void => {
    out.push(`  ${pad(label, 26)}${padStart(value, 10)}  ${pad(detail, 26)}${flag}`);
  };

  out.push("");
  out.push(BAR);
  out.push(`  MARGINALIA EVAL   config ${f.hash}${result.tag ? `   tag ${result.tag}` : ""}`);
  out.push(BAR);

  /* ── WHAT WAS RUN ─────────────────────────────────────────────────────── */
  const r = f.config.retrieval;
  const c = f.config.chunk;
  out.push(
    `  corpus     ${Object.keys(f.corpus).length} documents` +
      (corpus ? `, ${corpus.stats.pages} blocks, ${corpus.stats.chunks} passages` : ""),
  );
  // Derived from the question count rather than from `refusal.unanswerable`,
  // which counts only the ones that reached a refusal decision — zero under
  // --retrieval-only. The header describes the SET; the refusal block describes
  // what was measured.
  out.push(
    `  questions  ${f.questionCount} (${m.refusal.answerable} answerable, ` +
      `${f.questionCount - m.refusal.answerable} unanswerable)`,
  );
  out.push(
    `  chunking   target ${c.targetTokens} / max ${c.maxTokens} / min ${c.minTokens} tokens, ` +
      `overlap ${c.overlapRatio}, section-break ${c.sectionBreakRatio}`,
  );
  out.push(
    `  retrieval  k=${r.k} depth=${r.channelDepth} rrf-k=${r.rrfK} ` +
      `weights ${r.denseWeight}/${r.lexicalWeight} (dense/lexical) floor=${r.minRrfRatio}`,
  );
  out.push(
    `  rerank     ${r.rerank ? "on" : "off"}` +
      `        rewrite  ${r.rewrite ? "on" : "off"} (inert: every question is a first turn)`,
  );
  out.push(
    `  embeddings ${f.embeddingModel} (${f.embeddingDimensions}d, local)`,
  );
  out.push(
    `  generation ${f.config.generate ? `${f.model ?? "free pool"} · prompt ${f.promptVersion}` : "skipped (--retrieval-only)"}`,
  );
  out.push(BAR);

  /* ── RETRIEVAL ────────────────────────────────────────────────────────── */
  out.push("  RETRIEVAL                        over answerable questions only");
  const hits5 = Math.round(m.retrieval.recallAt5 * m.retrieval.questions);
  const hits10 = Math.round(m.retrieval.recallAt10 * m.retrieval.questions);
  row("recall@5", pct(m.retrieval.recallAt5), `${hits5}/${m.retrieval.questions} questions`, flagBelow(m.retrieval.recallAt5, 0.8));
  row("recall@10", pct(m.retrieval.recallAt10), `${hits10}/${m.retrieval.questions} questions`, flagBelow(m.retrieval.recallAt10, 0.9));
  row("MRR", num(m.retrieval.mrr), "1.0 = always rank 1", flagBelow(m.retrieval.mrr, 0.6));
  out.push("");

  /* ── CITATIONS ────────────────────────────────────────────────────────── */
  if (f.config.generate) {
    out.push("  CITATIONS");
    row(
      "validity",
      pct(m.citations.validity, 2),
      `${m.citations.emitted - m.citations.invalid}/${m.citations.emitted} markers`,
      m.citations.validity !== null && m.citations.validity < 1 ? "  << BUG" : "",
    );
    row(
      "support",
      pct(m.citations.support),
      `${m.citations.checked} cited passages checked`,
      flagBelow(m.citations.support, 0.7),
    );
    out.push("");

    /* ── REFUSAL ────────────────────────────────────────────────────────── */
    out.push("  REFUSAL                          both halves; neither means anything alone");
    row(
      "declined when it should",
      pct(m.refusal.accuracy),
      `${m.refusal.correct}/${m.refusal.unanswerable} unanswerable`,
      flagBelow(m.refusal.accuracy, 0.8),
    );
    row(
      "declined when it shouldn't",
      pct(m.refusal.answerable === 0 ? null : m.refusal.falseRefusals / m.refusal.answerable),
      `${m.refusal.falseRefusals}/${m.refusal.answerable} answerable`,
      m.refusal.falseRefusals > 0 ? "  << check these" : "",
    );
    out.push("");
  }

  /* ── LATENCY AND COST ─────────────────────────────────────────────────── */
  out.push("  LATENCY AND COST                 per question");
  row("total p50", ms(m.latency.p50Ms), "");
  row("total p95", ms(m.latency.p95Ms), "");
  row("retrieval p50", ms(m.latency.retrievalP50Ms), "");
  row("retrieval p95", ms(m.latency.retrievalP95Ms), "");
  row(
    "cost p50 / p95",
    `$${(m.cost.p50Cents / 100).toFixed(2)}`,
    `$${(m.cost.p95Cents / 100).toFixed(2)} · free tier`,
  );
  row(
    "tokens",
    m.cost.promptTokens.toLocaleString("en-US"),
    `in / ${m.cost.completionTokens.toLocaleString("en-US")} out`,
  );
  out.push(BAR);

  /* ── WHAT WENT WRONG ───────────────────────────────────────────────────── */
  const misses = result.outcomes.filter(
    (o) => !o.error && o.answerable && o.firstRelevantRank === null,
  );
  const deep = result.outcomes.filter(
    (o) => !o.error && o.answerable && o.firstRelevantRank !== null && o.firstRelevantRank > 5,
  );
  const errors = result.outcomes.filter((o) => o.error);
  const missedRefusals = result.outcomes.filter(
    (o) => !o.error && !o.answerable && o.refused === false,
  );
  const falseRefusals = result.outcomes.filter(
    (o) => !o.error && o.answerable && o.refused === true,
  );

  if (misses.length > 0) {
    out.push(`  NOT RETRIEVED AT ALL (${misses.length})`);
    for (const outcome of misses) out.push(`    ${outcome.id}  ${clip(outcome.question)}`);
    out.push("");
  }
  if (deep.length > 0) {
    out.push(`  RETRIEVED BELOW RANK 5 (${deep.length})`);
    for (const outcome of deep) {
      out.push(`    ${outcome.id}  rank ${outcome.firstRelevantRank}  ${clip(outcome.question)}`);
    }
    out.push("");
  }
  if (missedRefusals.length > 0) {
    out.push(`  ANSWERED SOMETHING UNANSWERABLE (${missedRefusals.length})`);
    for (const outcome of missedRefusals) {
      out.push(`    ${outcome.id}  ${clip(outcome.question)}`);
    }
    out.push("");
  }
  if (falseRefusals.length > 0) {
    out.push(`  DECLINED SOMETHING ANSWERABLE (${falseRefusals.length})`);
    for (const outcome of falseRefusals) {
      out.push(`    ${outcome.id}  rank ${outcome.firstRelevantRank ?? "—"}  ${clip(outcome.question)}`);
    }
    out.push("");
  }
  if (errors.length > 0) {
    out.push(`  ERRORS (${errors.length}) — excluded from every metric above`);
    for (const outcome of errors) {
      out.push(`    ${outcome.id}  ${outcome.error}`);
    }
    out.push("");
  }

  out.push(
    `  ${f.questionCount} hand-written questions over 3 documents. A starting point, not a benchmark —`,
  );
  out.push("  see evals/README.md for what each number does and does not measure.");
  out.push(BAR);

  return out.join("\n");
}

function flagBelow(value: number | null, target: number): string {
  if (value === null) return "";
  return value < target ? `  << below ${target}` : "";
}

function clip(text: string, width = 62): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

/* ========================================================================== *
 * THE DIFF
 * ========================================================================== */

/**
 * Two runs, side by side.
 *
 * The point is the DELTA column: a retrieval change is a number, not a
 * feeling. Everything else on the line is context for reading it.
 *
 * The header names every fingerprint field that differs between the two runs.
 * That is the most important part of this output and the easiest to leave out:
 * a diff that shows recall moving 0.72 → 0.80 is meaningless if the second run
 * also had a different question set, and there is no way to tell from the
 * numbers alone.
 */
export function renderComparison(a: EvalResult, b: EvalResult): string {
  const out: string[] = [];

  out.push("");
  out.push(BAR);
  out.push(`  COMPARE   A ${a.fingerprint.hash}${a.tag ? ` (${a.tag})` : ""}   →   B ${b.fingerprint.hash}${b.tag ? ` (${b.tag})` : ""}`);
  out.push(BAR);

  const differences = fingerprintDiff(a, b);
  if (differences.length === 0) {
    out.push("  configuration  identical — any delta below is run-to-run noise");
  } else {
    out.push("  configuration  changed:");
    for (const line of differences) out.push(`    ${line}`);
  }
  out.push(BAR);

  const line = (
    label: string,
    left: number | null,
    right: number | null,
    format: (value: number | null) => string,
    higherIsBetter = true,
  ): void => {
    const delta =
      left === null || right === null ? null : right - left;
    const arrow =
      delta === null || Math.abs(delta) < 1e-9
        ? "  ="
        : (delta > 0) === higherIsBetter
          ? " up"
          : " dn";
    // A negative delta already carries its sign from `format`; only a positive
    // one needs the "+" that makes the direction readable at a glance.
    const deltaText =
      delta === null ? "n/a" : `${delta >= 0 ? "+" : ""}${format(delta)}`;
    out.push(
      `  ${pad(label, 26)}${padStart(format(left), 10)}${padStart(format(right), 12)}${padStart(deltaText, 12)}${arrow}`,
    );
  };

  out.push(`  ${pad("", 26)}${padStart("A", 10)}${padStart("B", 12)}${padStart("delta", 12)}`);
  out.push("");

  const pctFmt = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
  const numFmt = (value: number | null) => (value === null ? "n/a" : value.toFixed(3));
  const msFmt = (value: number | null) => (value === null ? "n/a" : `${Math.round(value)}ms`);

  line("recall@5", a.metrics.retrieval.recallAt5, b.metrics.retrieval.recallAt5, pctFmt);
  line("recall@10", a.metrics.retrieval.recallAt10, b.metrics.retrieval.recallAt10, pctFmt);
  line("MRR", a.metrics.retrieval.mrr, b.metrics.retrieval.mrr, numFmt);
  line("citation validity", a.metrics.citations.validity, b.metrics.citations.validity, pctFmt);
  line("citation support", a.metrics.citations.support, b.metrics.citations.support, pctFmt);
  line("refusal accuracy", a.metrics.refusal.accuracy, b.metrics.refusal.accuracy, pctFmt);
  line(
    "false refusals",
    a.metrics.refusal.falseRefusals,
    b.metrics.refusal.falseRefusals,
    (v) => (v === null ? "n/a" : String(v)),
    false,
  );
  line("latency p50", a.metrics.latency.p50Ms, b.metrics.latency.p50Ms, msFmt, false);
  line("latency p95", a.metrics.latency.p95Ms, b.metrics.latency.p95Ms, msFmt, false);
  line(
    "retrieval p50",
    a.metrics.latency.retrievalP50Ms,
    b.metrics.latency.retrievalP50Ms,
    msFmt,
    false,
  );

  out.push("");

  /* ── WHICH QUESTIONS MOVED ─────────────────────────────────────────────────
   * The aggregate says whether a change helped. This says WHERE, which is the
   * only part you can act on: two questions fixed and one broken nets out to
   * "+1 question" in recall@5 and is a completely different situation from
   * three questions all improving slightly.
   */
  const byId = new Map(a.outcomes.map((outcome) => [outcome.id, outcome]));
  const improved: string[] = [];
  const regressed: string[] = [];

  for (const after of b.outcomes) {
    const before = byId.get(after.id);
    if (!before || !after.answerable) continue;

    const rankBefore = before.firstRelevantRank ?? Infinity;
    const rankAfter = after.firstRelevantRank ?? Infinity;
    if (rankAfter === rankBefore) continue;

    const label = `${after.id}  rank ${fmtRank(before.firstRelevantRank)} → ${fmtRank(after.firstRelevantRank)}  ${clip(after.question, 46)}`;
    (rankAfter < rankBefore ? improved : regressed).push(label);
  }

  if (improved.length > 0) {
    out.push(`  IMPROVED (${improved.length})`);
    for (const label of improved) out.push(`    ${label}`);
    out.push("");
  }
  if (regressed.length > 0) {
    out.push(`  REGRESSED (${regressed.length})`);
    for (const label of regressed) out.push(`    ${label}`);
    out.push("");
  }
  if (improved.length === 0 && regressed.length === 0) {
    out.push("  No question changed rank.");
    out.push("");
  }

  const onlyInA = a.outcomes.filter((o) => !b.outcomes.some((x) => x.id === o.id));
  const onlyInB = b.outcomes.filter((o) => !a.outcomes.some((x) => x.id === o.id));
  if (onlyInA.length > 0 || onlyInB.length > 0) {
    out.push(
      `  ! the two runs do not cover the same questions — ${onlyInA.length} only in A, ${onlyInB.length} only in B.`,
    );
    out.push("    Aggregate deltas above are not a like-for-like comparison.");
    out.push("");
  }

  out.push(BAR);
  return out.join("\n");
}

function fmtRank(rank: number | null): string {
  return rank === null ? "miss" : String(rank);
}

/** Every fingerprint field that differs, in words. */
function fingerprintDiff(a: EvalResult, b: EvalResult): string[] {
  const lines: string[] = [];
  const fa = a.fingerprint;
  const fb = b.fingerprint;

  const compare = (label: string, left: unknown, right: unknown): void => {
    const l = JSON.stringify(left);
    const r = JSON.stringify(right);
    if (l !== r) lines.push(`${pad(label, 22)} ${l}  →  ${r}`);
  };

  for (const key of Object.keys(fa.config.chunk) as Array<keyof typeof fa.config.chunk>) {
    compare(`chunk.${key}`, fa.config.chunk[key], fb.config.chunk[key]);
  }
  for (const key of Object.keys(fa.config.retrieval) as Array<
    keyof typeof fa.config.retrieval
  >) {
    compare(`retrieval.${key}`, fa.config.retrieval[key], fb.config.retrieval[key]);
  }
  compare("generate", fa.config.generate, fb.config.generate);
  compare("embeddingModel", fa.embeddingModel, fb.embeddingModel);
  compare("promptVersion", fa.promptVersion, fb.promptVersion);
  compare("questionSet", fa.questionSet.slice(0, 12), fb.questionSet.slice(0, 12));
  compare("questionCount", fa.questionCount, fb.questionCount);
  for (const id of new Set([...Object.keys(fa.corpus), ...Object.keys(fb.corpus)])) {
    compare(`corpus.${id}`, fa.corpus[id]?.slice(0, 12), fb.corpus[id]?.slice(0, 12));
  }

  return lines;
}

/** A one-line progress record, printed as each question finishes. */
export function renderProgress(
  index: number,
  total: number,
  outcome: QuestionOutcome,
): string {
  const position = `${String(index + 1).padStart(String(total).length)}/${total}`;

  if (outcome.error) return `  ${position}  ${pad(outcome.id, 22)} ERROR  ${outcome.error}`;

  // `refused` is null under --retrieval-only: nothing generated, so nothing to
  // decline. Printing "ANSWERED" there would report a failure that was never
  // measured — which is the one thing a progress line must not do.
  const rank = outcome.answerable
    ? `rank ${fmtRank(outcome.firstRelevantRank).padEnd(4)}`
    : outcome.refused === null
      ? "not generated"
      : `${outcome.refused ? "declined" : "ANSWERED"}    `;

  const cites =
    outcome.validMarkers + outcome.invalidMarkers > 0
      ? `${outcome.validMarkers} cites${outcome.invalidMarkers > 0 ? ` +${outcome.invalidMarkers} invalid` : ""}`
      : "";

  return `  ${position}  ${pad(outcome.id, 22)} ${rank}  ${padStart(ms(outcome.totalMs), 8)}  ${cites}`;
}
