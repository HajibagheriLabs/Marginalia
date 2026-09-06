import { createHash } from "node:crypto";

import { CHUNKING } from "@/lib/ingest/chunk";
import { PROMPT_VERSION } from "@/lib/llm/prompt";
import { ASSEMBLY } from "@/lib/retrieval/assemble";
import { RETRIEVAL } from "@/lib/retrieval";
import { RRF_K } from "@/lib/retrieval/rrf";

import type { ChunkConfig, ConfigFingerprint, EvalConfig, RetrievalConfig } from "./types";

/**
 * THE KNOBS, AND WHERE THEIR DEFAULTS COME FROM.
 *
 * Every default below is READ FROM THE PRODUCTION CONSTANT, not copied next to
 * it. `targetTokens` is `CHUNKING.targetTokens`; `k` is `ASSEMBLY.k`; `rrfK` is
 * `RRF_K`. That is the difference between an eval that measures the product and
 * one that measures a config file someone forgot to update — the second kind
 * reports a number for a pipeline that has not existed for three months, and
 * nothing about it looks wrong.
 *
 * So `npm run eval` with no flags always measures exactly what ships, and every
 * flag is an explicit deviation from it, printed in the report header.
 */

export function defaultChunkConfig(): ChunkConfig {
  return {
    targetTokens: CHUNKING.targetTokens,
    maxTokens: CHUNKING.maxTokens,
    minTokens: CHUNKING.minTokens,
    overlapRatio: CHUNKING.overlapRatio,
    sectionBreakRatio: CHUNKING.sectionBreakRatio,
  };
}

export function defaultRetrievalConfig(rerank: boolean, rewrite: boolean): RetrievalConfig {
  return {
    channelDepth: RETRIEVAL.channelDepth,
    k: ASSEMBLY.k,
    rrfK: RRF_K,
    denseWeight: 1,
    lexicalWeight: 1,
    minRrfRatio: ASSEMBLY.minRrfRatio,
    minRerankScore: ASSEMBLY.minRerankScore,
    rerank,
    rewrite,
  };
}

/* ========================================================================== *
 * THE COMMAND LINE
 * ========================================================================== */

export interface CliOptions {
  config: EvalConfig;
  /** Run only the first N questions. For a smoke test, not for a score. */
  limit: number | null;
  /** Run only questions whose id contains this. */
  filter: string | null;
  tag: string | null;
  /** Re-ingest even when the cached corpus matches the chunk config. */
  reingest: boolean;
  /** Two result files to diff instead of running. */
  compare: [string, string] | null;
  help: boolean;
}

const USAGE = `
Marginalia offline evaluation harness

  npm run eval                          run every question with the shipping defaults
  npm run eval -- --retrieval-only      retrieval metrics only; calls no model
  npm run eval -- --compare A B         diff two result files in evals/results/

RETRIEVAL KNOBS (re-runs queries; no re-ingest)
  --k <n>                   passages assembled into the context      (default ${ASSEMBLY.k})
  --depth <n>               candidates from each channel before fusion (default ${RETRIEVAL.channelDepth})
  --rrf-k <n>               RRF flattening constant                  (default ${RRF_K})
  --dense-weight <f>        weight on the dense channel              (default 1)
  --lexical-weight <f>      weight on the lexical channel            (default 1)
  --min-rrf-ratio <f>       relative relevance floor                 (default ${ASSEMBLY.minRrfRatio})
  --min-rerank-score <f>    absolute floor when reranking            (default ${ASSEMBLY.minRerankScore})
  --rerank / --no-rerank    cross-encoder reranking                  (default: RETRIEVAL_RERANKER)
  --rewrite / --no-rewrite  multi-turn query rewriting               (default: RETRIEVAL_QUERY_REWRITE)

CHUNKING KNOBS (force a re-ingest of the corpus)
  --target-tokens <n>       chunk size target                        (default ${CHUNKING.targetTokens})
  --max-tokens <n>          hard ceiling                             (default ${CHUNKING.maxTokens})
  --min-tokens <n>          merge floor                              (default ${CHUNKING.minTokens})
  --overlap <f>             overlap as a fraction of the target      (default ${CHUNKING.overlapRatio})
  --section-break-ratio <f> how full before a heading may split      (default ${CHUNKING.sectionBreakRatio})

RUN CONTROL
  --retrieval-only          skip generation entirely
  --limit <n>               first N questions only (smoke test, not a score)
  --filter <text>           only questions whose id contains <text>
  --tag <text>              name the result file
  --reingest                re-ingest even when the cache matches
  --help
`.trimStart();

export function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice();

  const compareAt = args.indexOf("--compare");
  if (compareAt !== -1) {
    const [a, b] = args.slice(compareAt + 1, compareAt + 3);
    if (!a || !b) {
      throw new Error("--compare needs two result files: --compare A B");
    }
    return {
      config: emptyConfig(),
      limit: null,
      filter: null,
      tag: null,
      reingest: false,
      compare: [a, b],
      help: false,
    };
  }

  if (args.includes("--help") || args.includes("-h")) {
    return {
      config: emptyConfig(),
      limit: null,
      filter: null,
      tag: null,
      reingest: false,
      compare: null,
      help: true,
    };
  }

  const flag = (name: string): boolean => args.includes(`--${name}`);
  const value = (name: string): string | null => {
    const at = args.indexOf(`--${name}`);
    if (at === -1) return null;
    const next = args[at + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`--${name} needs a value`);
    }
    return next;
  };
  const num = (name: string, fallback: number): number => {
    const raw = value(name);
    if (raw === null) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number`);
    return parsed;
  };

  // A boolean knob whose default is an ENVIRONMENT setting, so `npm run eval`
  // with no flags measures the deployment as configured rather than a shape
  // the product is never actually run in.
  const boolFlag = (name: string, fallback: boolean): boolean => {
    if (flag(name)) return true;
    if (flag(`no-${name}`)) return false;
    return fallback;
  };

  const chunk = defaultChunkConfig();
  const retrieval = defaultRetrievalConfig(
    process.env.RETRIEVAL_RERANKER === "local",
    process.env.RETRIEVAL_QUERY_REWRITE === "on",
  );

  return {
    config: {
      chunk: {
        targetTokens: num("target-tokens", chunk.targetTokens),
        maxTokens: num("max-tokens", chunk.maxTokens),
        minTokens: num("min-tokens", chunk.minTokens),
        overlapRatio: num("overlap", chunk.overlapRatio),
        sectionBreakRatio: num("section-break-ratio", chunk.sectionBreakRatio),
      },
      retrieval: {
        channelDepth: num("depth", retrieval.channelDepth),
        k: num("k", retrieval.k),
        rrfK: num("rrf-k", retrieval.rrfK),
        denseWeight: num("dense-weight", retrieval.denseWeight),
        lexicalWeight: num("lexical-weight", retrieval.lexicalWeight),
        minRrfRatio: num("min-rrf-ratio", retrieval.minRrfRatio),
        minRerankScore: num("min-rerank-score", retrieval.minRerankScore),
        rerank: boolFlag("rerank", retrieval.rerank),
        rewrite: boolFlag("rewrite", retrieval.rewrite),
      },
      generate: !flag("retrieval-only"),
    },
    limit: value("limit") === null ? null : num("limit", 0),
    filter: value("filter"),
    tag: value("tag"),
    reingest: flag("reingest"),
    compare: null,
    help: false,
  };
}

function emptyConfig(): EvalConfig {
  return {
    chunk: defaultChunkConfig(),
    retrieval: defaultRetrievalConfig(false, false),
    generate: false,
  };
}

export function usage(): string {
  return USAGE;
}

/* ========================================================================== *
 * FINGERPRINTING
 * ========================================================================== */

/**
 * A stable digest of everything that could move a number.
 *
 * Two properties matter.
 *
 * STABILITY: the JSON is built with sorted keys, so a reordered interface
 * declaration does not invent a new hash and make an unchanged pipeline look
 * like a different one.
 *
 * COVERAGE: it hashes more than the knobs. The corpus digests are in it because
 * an amended regulation changes the answers; the question-set digest is in it
 * because an edited question changes the score; the embedding model is in it
 * because a different vector space is a different retrieval system; the prompt
 * version is in it because a grounding score is meaningless without knowing
 * which prompt produced it. Anything left out is something two "identical"
 * runs could silently differ on.
 */
export function fingerprint(input: {
  config: EvalConfig;
  embeddingModel: string;
  embeddingDimensions: number;
  model: string | null;
  corpus: Record<string, string>;
  questionSet: string;
  questionCount: number;
}): ConfigFingerprint {
  const payload = {
    config: input.config,
    embeddingModel: input.embeddingModel,
    embeddingDimensions: input.embeddingDimensions,
    model: input.model,
    promptVersion: PROMPT_VERSION,
    corpus: input.corpus,
    questionSet: input.questionSet,
  };

  const hash = createHash("sha256")
    .update(canonical(payload))
    .digest("hex")
    .slice(0, 12);

  return { hash, promptVersion: PROMPT_VERSION, ...input };
}

/**
 * JSON with every object's keys sorted, at every depth.
 *
 * `JSON.stringify` preserves insertion order, so two structurally identical
 * configs built by different code paths would hash differently. That failure is
 * invisible — you would just see a config hash change and assume something
 * moved.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);

  return `{${entries.join(",")}}`;
}

/**
 * The chunking half of the fingerprint, on its own.
 *
 * Ingestion is expensive — embedding the whole corpus locally is minutes of
 * CPU — and it depends on the chunk config and the corpus, and on nothing else.
 * So it is cached against this narrower hash: sweeping `--rrf-k` across ten
 * values re-ingests zero times, and only a chunk-size change pays for it.
 */
export function ingestHash(
  chunk: ChunkConfig,
  corpus: Record<string, string>,
  embeddingModel: string,
): string {
  return createHash("sha256")
    .update(canonical({ chunk, corpus, embeddingModel }))
    .digest("hex")
    .slice(0, 12);
}

export { canonical };
