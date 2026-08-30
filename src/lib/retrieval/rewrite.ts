import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";

import { env } from "@/lib/env";

/**
 * MULTI-TURN QUERY REWRITING — off by default.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE PROBLEM IT SOLVES
 *
 * Retrieval sees one string. A conversation does not work that way:
 *
 *     "What are the termination provisions?"
 *     → answers about clauses 7.1, 7.2 and 7.3
 *     "What about the second one?"
 *
 * "What about the second one?" retrieves nothing useful, and it is not a close
 * call — the string contains no content words at all. Both channels fail, for
 * different reasons and equally completely: there is nothing for the embedding
 * to be near, and after stopword removal the tsquery is EMPTY. The follow-up
 * that feels most natural to type is the one the system is worst at.
 *
 * Rewriting resolves the reference before retrieval runs: "What about the
 * second one?" becomes "What are the termination for convenience provisions in
 * clause 7.2?", which both channels handle.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY IT IS OFF
 *
 * It costs a model round trip on the request path, before retrieval can even
 * start, so it is felt directly as latency on every turn — including the many
 * turns that are already self-contained and gain nothing.
 *
 * And it can make things WORSE. A rewrite is a model output, so it can hallucinate
 * specificity the user never asked for — turning "what about the other one?"
 * into a question about a named clause the conversation never mentioned, and
 * retrieving confidently for a question nobody asked. When the rewrite is
 * wrong, everything downstream is wrong, and the trace shows a perfectly
 * sensible retrieval for the wrong query.
 *
 * Whether that trade is worth it depends on how people actually use this, which
 * is a measurement rather than an opinion. `RETRIEVAL_QUERY_REWRITE=on` makes
 * it measurable against the same eval set with it off.
 */

export const REWRITE = {
  /** How many prior turns to show. Enough to resolve a reference, not a summary. */
  historyTurns: 6,
  /** A rewrite longer than this has stopped being a query. */
  maxQueryChars: 300,
  /**
   * Wall-clock budget. Rewriting is an OPTIMISATION, so it must never be able
   * to make the product slower than not having it: past this, the original
   * question is used and retrieval carries on.
   */
  timeoutMs: 4_000,
} as const;

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Deliberately narrow, and it says so out loud.
 *
 * The instruction to return the question UNCHANGED when it is already
 * self-contained is the load-bearing line. Without it the model helpfully
 * "improves" every question — adding synonyms, expanding abbreviations,
 * turning a precise query into a verbose one — and a question that was working
 * perfectly retrieves differently for no reason. Most turns should pass
 * through untouched.
 */
const SYSTEM_PROMPT = [
  "You rewrite follow-up questions into standalone search queries.",
  "",
  "Given a conversation and the user's latest question, resolve any pronouns or",
  "references that depend on earlier turns, using only what the conversation",
  "actually says.",
  "",
  "Rules:",
  "- If the question already stands alone, return it UNCHANGED.",
  "- Never add facts, clause numbers, or terms the conversation did not mention.",
  "- Keep it short and keep the user's own wording wherever possible.",
  "- Return only the rewritten query. No preamble, no quotes, no explanation.",
].join("\n");

function isEnabled(): boolean {
  return env.RETRIEVAL_QUERY_REWRITE === "on";
}

/**
 * Rewrite a follow-up into a standalone query.
 *
 * ALWAYS RETURNS A USABLE QUERY. Every failure path — disabled, no history, a
 * model error, a timeout, an empty or overlong response — returns the original
 * question. That is not defensive padding: rewriting is an accelerator on the
 * front of the pipeline, and an accelerator that can break the pipeline is a
 * worse deal than not having one. A retrieval that runs on the raw question is
 * merely less good; a retrieval that throws has no answer at all.
 */
export async function rewriteQuery(
  history: ConversationTurn[],
  question: string,
): Promise<{ query: string; rewritten: boolean }> {
  const original = { query: question, rewritten: false };

  if (!isEnabled()) return original;
  // The first turn of a conversation has nothing to resolve against.
  if (history.length === 0) return original;

  const recent = history.slice(-REWRITE.historyTurns);
  const transcript = recent
    .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}`)
    .join("\n");

  try {
    const openrouter = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY });

    const result = await generateText({
      model: openrouter.chat(env.OPENROUTER_MODEL),
      system: SYSTEM_PROMPT,
      prompt: `Conversation:\n${transcript}\n\nLatest question: ${question}\n\nStandalone query:`,
      // A rewrite is one line. Capping it is both a cost control and a guard
      // against a model that decides to explain itself.
      maxOutputTokens: 120,
      // Deterministic: the same follow-up in the same conversation must
      // retrieve the same passages, or the trace stops being reproducible and
      // the eval harness measures noise.
      temperature: 0,
      abortSignal: AbortSignal.timeout(REWRITE.timeoutMs),
    });

    const rewritten = result.text.trim().replace(/^["']|["']$/g, "");

    if (rewritten.length === 0 || rewritten.length > REWRITE.maxQueryChars) {
      return original;
    }
    if (rewritten === question) return original;

    return { query: rewritten, rewritten: true };
  } catch (error) {
    // Logged, not thrown. See the header.
    console.warn("[retrieval] query rewrite failed; using the original", error);
    return original;
  }
}
