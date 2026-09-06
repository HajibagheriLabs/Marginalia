import { eq } from "drizzle-orm";

import { db } from "@/db";
import { conversations } from "@/db/schema";
import { answer } from "@/lib/llm";
import type { AnswerEvent } from "@/lib/llm/types";
import { createLocalReranker, retrieve } from "@/lib/retrieval";
import type { RetrievalCandidate, RetrievedPassage } from "@/lib/retrieval";

import type { Corpus } from "./corpus";
import { containsAnyPhrase, coversExpectedPage, normalise } from "./metrics";
import type { EvalConfig, EvalQuestion, QuestionOutcome } from "./types";

/**
 * ONE QUESTION, THROUGH THE SHIPPING PIPELINE.
 *
 *   question
 *     → retrieve()   with this run's tuning
 *     → answer()     with those passages injected
 *     → score
 *
 * The one thing worth understanding here is WHY retrieval is called separately
 * and then handed to `answer()` rather than letting `answer()` retrieve.
 *
 * `answer()` calls `retrieve()` itself and does not take tuning — correctly, in
 * production, where there is exactly one configuration. But the whole point of
 * this harness is running the pipeline under many configurations, so retrieval
 * happens here with `tuning`, and the result is passed through
 * `deps.retrieval` — a seam that already exists because the answer engine's
 * own integration tests use it.
 *
 * What that buys: everything downstream of retrieval is the REAL code path.
 * The prompt is `buildSystemPrompt`, the model call is the real pool with real
 * failover, marker parsing is `validateCitations`, and the message and citation
 * rows are written by the same functions the product writes them with. Only the
 * arguments to retrieval differ from a live request.
 *
 * What it costs: the eval cannot measure a change to how `answer()` chooses to
 * retrieve, because it does not use that path. Named in evals/README.md.
 */

export interface RunContext {
  corpus: Corpus;
  config: EvalConfig;
  /** Reused across every question, so the conversation row is created once. */
  conversationId: string;
}

/**
 * A conversation for the run to hang messages off.
 *
 * `answer()` writes a `messages` row for every answer and links citations and
 * the retrieval trace to it, which is exactly the behaviour being tested — a
 * harness that skipped persistence would not be exercising citation storage at
 * all. One conversation per run keeps those rows findable and lets a failed run
 * be inspected afterwards in the database.
 *
 * It is NOT reused between runs: a fresh row per run means the messages of two
 * runs never interleave in one thread.
 */
export async function createRunConversation(corpus: Corpus): Promise<string> {
  const [row] = await db
    .insert(conversations)
    .values({
      userId: corpus.userId,
      title: `eval ${new Date().toISOString()}`,
      documentIds: corpus.scope,
    })
    .returning({ id: conversations.id });
  return row.id;
}

export async function deleteRunConversation(id: string): Promise<void> {
  // Messages, citations, and retrievals all cascade from here.
  await db.delete(conversations).where(eq(conversations.id, id));
}

export async function runQuestion(
  context: RunContext,
  question: EvalQuestion,
): Promise<QuestionOutcome> {
  const { corpus, config } = context;
  const startedAt = Date.now();

  const base: QuestionOutcome = {
    id: question.id,
    question: question.question,
    answerable: question.answerable,
    document: question.document,
    expectedPages: question.expected_pages,
    firstRelevantRank: null,
    candidateCount: 0,
    contextPassageCount: 0,
    answer: null,
    model: null,
    validMarkers: 0,
    invalidMarkers: 0,
    supportedCitations: null,
    citedPassages: 0,
    refused: null,
    refusalSignal: null,
    retrievalMs: 0,
    generationMs: 0,
    totalMs: 0,
    costCents: 0,
    promptTokens: null,
    completionTokens: null,
  };

  /* ── RETRIEVE ──────────────────────────────────────────────────────────── */
  let passages: RetrievedPassage[];
  let candidates: RetrievalCandidate[];
  const retrievalStartedAt = Date.now();

  try {
    const result = await retrieve({
      userId: corpus.userId,
      documentIds: corpus.scope,
      query: question.question,
      k: config.retrieval.k,
      tuning: {
        channelDepth: config.retrieval.channelDepth,
        rrfK: config.retrieval.rrfK,
        denseWeight: config.retrieval.denseWeight,
        lexicalWeight: config.retrieval.lexicalWeight,
        minRrfRatio: config.retrieval.minRrfRatio,
        minRerankScore: config.retrieval.minRerankScore,
      },
      deps: {
        /*
         * THE RERANKER IS CONSTRUCTED, NOT REQUESTED.
         *
         * `getReranker()` is the production factory and it returns null unless
         * `RETRIEVAL_RERANKER=local` is set in the environment — correct there,
         * and wrong here: passing it would make `--rerank` a silent no-op on
         * any machine whose `.env.local` has reranking off, which is the
         * default and therefore most machines. The run would complete, report a
         * config hash saying rerank was on, and produce numbers identical to
         * the baseline. An eval that reports a knob as measured when it was
         * never applied is worse than one that cannot set the knob at all.
         *
         * So the flag builds the reranker directly. Explicit null is the other
         * half: `--no-rerank` forces it off even when the environment enables
         * it, so both directions of the flag mean what they say.
         */
        vectors: corpus.store,
        reranker: config.retrieval.rerank ? createLocalReranker() : null,
      },
    });
    passages = result.passages;
    candidates = result.candidates;
  } catch (error) {
    return {
      ...base,
      totalMs: Date.now() - startedAt,
      retrievalMs: Date.now() - retrievalStartedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  base.retrievalMs = Date.now() - retrievalStartedAt;
  base.candidateCount = candidates.length;
  base.contextPassageCount = passages.length;

  /* ── RETRIEVAL SCORING ─────────────────────────────────────────────────────
   * The rank of the first candidate that covers an expected page.
   *
   * Over `candidates`, which is the FUSED, FINAL-ORDER list — including the
   * ones that lost — rather than over `passages`, which is the eight that
   * survived the relevance floor. Scoring over `passages` would make recall@10
   * unmeasurable, since there are never ten, and would conflate two different
   * failures: "retrieval did not find it" and "assembly cut it".
   */
  if (question.answerable && question.document) {
    const expectedDocumentId = corpus.documentIds.get(question.document);
    if (!expectedDocumentId) {
      return {
        ...base,
        totalMs: Date.now() - startedAt,
        error: `question names document "${question.document}", which is not in the corpus manifest`,
      };
    }

    const at = candidates.findIndex((candidate) =>
      coversExpectedPage(candidate, expectedDocumentId, question.expected_pages),
    );
    base.firstRelevantRank = at === -1 ? null : at + 1;
  }

  if (!config.generate) {
    return { ...base, totalMs: Date.now() - startedAt };
  }

  /* ── GENERATE ──────────────────────────────────────────────────────────── */
  const generationStartedAt = Date.now();
  let text = "";
  let citedMarkers: number[] = [];
  let errorMessage: string | null = null;

  try {
    for await (const event of answer({
      userId: corpus.userId,
      conversationId: context.conversationId,
      documentIds: corpus.scope,
      question: question.question,
      deps: {
        // The retrieval this run configured, not a second retrieval with the
        // shipping defaults.
        retrieval: { passages, candidates },
      },
    })) {
      applyEvent(event, base, (delta) => (text += delta), (markers) => {
        citedMarkers = markers;
      });
      if (event.type === "error") errorMessage = event.message;
    }
  } catch (error) {
    return {
      ...base,
      answer: text || null,
      generationMs: Date.now() - generationStartedAt,
      totalMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  base.generationMs = Date.now() - generationStartedAt;
  base.totalMs = Date.now() - startedAt;
  base.answer = text;

  if (errorMessage) {
    // The engine refused before generating — a spent quota, an unready
    // document. Recorded as an error rather than scored: a run where half the
    // questions hit a rate limit must not report a recall number as if it
    // measured retrieval.
    return { ...base, error: errorMessage };
  }

  /* ── CITATION SUPPORT ──────────────────────────────────────────────────────
   * For each marker the model emitted, does the passage behind it contain one
   * of the phrases we know answer this question?
   *
   * `citedMarkers` are the VALIDATED ones — invented markers were already
   * stripped by `validateCitations` — so this is asking a strictly harder
   * question than validity: the citation points at a real retrieved passage,
   * but is it the right passage?
   */
  if (question.answerable && question.expected_phrases.length > 0) {
    const byMarker = new Map(passages.map((passage) => [passage.marker, passage]));
    const cited = citedMarkers
      .map((marker) => byMarker.get(marker))
      .filter((passage) => passage !== undefined);

    base.citedPassages = cited.length;
    base.supportedCitations =
      cited.length === 0
        ? null
        : cited.filter((passage) =>
            containsAnyPhrase(passage.text, question.expected_phrases),
          ).length;
  }

  /* ── REFUSAL ───────────────────────────────────────────────────────────── */
  const refusal = detectRefusal(text, base.contextPassageCount === 0);
  base.refused = refusal.refused;
  base.refusalSignal = refusal.signal;

  return base;
}

function applyEvent(
  event: AnswerEvent,
  outcome: QuestionOutcome,
  appendText: (delta: string) => void,
  setMarkers: (markers: number[]) => void,
): void {
  switch (event.type) {
    case "text":
      appendText(event.delta);
      break;
    case "citations":
      setMarkers(event.citations.map((citation) => citation.marker));
      outcome.validMarkers = event.citations.length;
      break;
    case "done":
      outcome.model = event.message.model;
      outcome.invalidMarkers = event.message.invalidMarkers.length;
      outcome.costCents = event.message.costCents;
      outcome.promptTokens = event.message.promptTokens;
      outcome.completionTokens = event.message.completionTokens;
      break;
    default:
      break;
  }
}

/**
 * DID THE SYSTEM DECLINE?
 *
 * Two signals, and they are not equally strong.
 *
 * `no-context` is DEFINITIVE. Retrieval found nothing above the relevance
 * floor, `answer()` short-circuited without calling a model at all, and the
 * sentence returned is the one written in `prompt.ts`. There is no judgement
 * involved: the system structurally could not have invented anything.
 *
 * A PHRASE MATCH is a heuristic, and it is the weak part of this harness. The
 * system prompt tells the model to say plainly that the passages do not answer
 * the question, so a decline reliably contains one of a small family of
 * sentences — but the model writes it in its own words, and a regex over
 * English is exactly the kind of thing that looks fine until it does not.
 *
 * Two decisions follow from knowing that:
 *
 *   - The signal is RECORDED on every outcome, so a suspicious refusal score
 *     can be audited question by question rather than taken on trust.
 *   - The patterns anchor on the NEGATION plus a reference to the documents
 *     ("do not contain", "these documents do not say"), not on a single word
 *     like "no". An answer that legitimately says "no, the rule does not apply
 *     to a covered entity [3]" is a real answer with a citation in it, and
 *     counting it as a refusal would inflate refusal accuracy while destroying
 *     the false-refusal count that is supposed to catch exactly that.
 *
 * evals/README.md says the same thing where a reader will see it.
 */
const REFUSAL_PATTERNS: RegExp[] = [
  /\bnothing in (this|these|the) (document|documents|passages?)\b/,
  /\b(do|does) not (contain|cover|address|mention|specify|say|provide|discuss|include)\b/,
  /\b(is|are) not (covered|addressed|mentioned|discussed|specified|included)\b/,
  /\bno (information|mention|reference|guidance|provision|passage)\b/,
  /\b(cannot|can't|could not|couldn't) (be )?(answer|answered|determine|determined|find|found)\b/,
  /\b(the )?(provided )?passages? do(es)? not\b/,
  /\bnot (found|present|available) in (this|these|the)\b/,
];

export function detectRefusal(
  text: string,
  emptyContext: boolean,
): { refused: boolean; signal: "no-context" | "phrase" | "none" } {
  // The structural signal wins. Retrieval returned nothing above the floor, so
  // no model was called and the sentence is a known constant.
  if (emptyContext) return { refused: true, signal: "no-context" };

  const flat = normalise(text);
  const matched = REFUSAL_PATTERNS.some((pattern) => pattern.test(flat));
  return matched
    ? { refused: true, signal: "phrase" }
    : { refused: false, signal: "none" };
}
