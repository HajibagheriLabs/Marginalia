/**
 * THE SYSTEM PROMPT.
 *
 * One file, versioned, and readable end to end. It lives alone because it is
 * the single largest lever on answer quality in this application and the one
 * most likely to be edited under pressure — and an edit here changes what every
 * answer in the product is allowed to say. Burying it inside the streaming code
 * would make it something people tweak while debugging something else.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY IT IS VERSIONED
 *
 * `PROMPT_VERSION` is recorded nowhere yet and is exported anyway, because the
 * eval harness needs it: a grounding score is meaningless without knowing which
 * prompt produced it, and "we changed the prompt and things got better" is not
 * a measurement unless both sides are labelled. Bump it on any change that
 * could move behaviour — a reworded rule counts, a fixed typo does not.
 */

export const PROMPT_VERSION = "2026-08-30.1";

/**
 * The rules, in priority order.
 *
 * The ordering is deliberate: everything below the first rule is a refinement
 * of it. If the model can only follow one instruction, "answer only from the
 * passages" is the one that keeps the product honest — a beautifully cited
 * answer drawn from the model's own memory is worse than no answer, because it
 * is indistinguishable from a correct one.
 *
 * WHAT IS NOT HERE, and why:
 *
 *   - No persona. "You are a helpful legal assistant" invites the model to
 *     behave like one, which means volunteering advice, hedging, and reasoning
 *     from professional knowledge — all of which are ungrounded by definition.
 *   - No "be accurate" or "do not hallucinate". Instructions the model cannot
 *     act on spend attention without changing behaviour. Every rule below is
 *     mechanically checkable by the model as it writes.
 *   - No tone instructions beyond brevity. The UI writing rules govern the
 *     interface; the answer should sound like the documents.
 */
const RULES = [
  "Answer ONLY from the numbered passages below. They are the entire world.",
  "Do not use outside knowledge, even when you are confident and even when the passages are incomplete.",
  "",
  "CITATIONS",
  "- Attach a marker like [1] to every factual claim, immediately after the claim it supports.",
  "- Cite the passage the claim actually came from. Never cite a passage you did not use.",
  "- Never invent a marker number. Only the numbers shown below exist.",
  "- Use several markers when a claim rests on several passages: [2][5].",
  "",
  "WHEN THE PASSAGES DO NOT ANSWER THE QUESTION",
  "- Say so plainly, in one sentence. This is a correct answer, not a failure, and it must not be dressed up as one.",
  "- Then say what the passages DO cover, with markers.",
  "- Then suggest what to look for instead — a section, a term, or a document that might hold it.",
  "- Do not guess, do not extrapolate, and do not answer a nearby question you can answer.",
  "",
  "STYLE",
  "- Summarise in your own words. Quote only when the exact wording is the point, and keep quotes under a sentence.",
  "- Be brief. Answer the question asked, not the surrounding topic.",
  "- Plain sentences. No preamble, no restating the question, no closing summary.",
].join("\n");

/**
 * Build the system prompt.
 *
 * `passageCount` is interpolated so the model is told the exact range of legal
 * markers. Naming the upper bound measurably reduces out-of-range citations —
 * "[1] to [6]" is a constraint it can check itself against, where "the passages
 * below" is something it has to infer by counting.
 */
export function buildSystemPrompt(passageCount: number): string {
  const range =
    passageCount === 1
      ? "Only [1] exists."
      : `Only [1] to [${passageCount}] exist.`;

  return [
    "You answer questions about documents the user has uploaded, using only the passages provided.",
    "",
    RULES,
    "",
    `There are ${passageCount} numbered passages. ${range} Any other number is an error.`,
  ].join("\n");
}

/**
 * The answer given when retrieval found nothing worth showing the model.
 *
 * Written here, next to the prompt, because it is the same product voice and
 * has to stay consistent with what the model is told to say in the same
 * situation. Returned WITHOUT calling a model — there is nothing to reason
 * over, and asking a model to say "I don't know" costs a request from a shared
 * free quota to produce a sentence already known in advance.
 */
export function noContextAnswer(documentCount: number): string {
  const scope =
    documentCount === 1 ? "this document" : `these ${documentCount} documents`;
  return (
    `Nothing in ${scope} covers that. ` +
    "Try rephrasing with terms the document itself would use, or check that the right documents are selected."
  );
}
