/**
 * THE CONVERSATION TITLE.
 *
 * A conversation is titled once, from its first question, and never again — a
 * title that moved as a thread grew would break the one thing a rail entry is
 * for, which is finding a thread you remember.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS DOES NOT CALL A MODEL
 *
 * The obvious implementation asks a model to summarise the question in five
 * words. This does not, for the same reason `noContextAnswer` does not: the
 * OpenRouter free pool is roughly 200 requests per DAY shared across every user
 * of the deployment, and a title is not worth one of them. Starting three
 * conversations would spend three answers' worth of quota on decoration.
 *
 * A model would also be strictly worse here in two ways that matter. It is a
 * second thing that can fail, on the path that creates a conversation — so a
 * rate limit would either block the first question or leave threads
 * intermittently untitled. And it is non-deterministic: the same question would
 * produce a different rail entry on different days, which is exactly the
 * instability the "titled once" rule exists to prevent.
 *
 * The question the user typed is already a summary of the thread. Trimming it
 * is a better title than a paraphrase of it, and it is instant, free, and
 * identical every time.
 *
 * The seam is here if that trade ever stops holding: one exported function,
 * called from one place. Swapping it for a model call is a change to this file.
 */

/** The rail is 240px wide; this is what fits on two lines at 13px. */
const MAX_LENGTH = 60;

/**
 * Openers that carry no information about the SUBJECT of a question.
 *
 * Stripped so that "Can you tell me what the notice period is?" titles as
 * "What the notice period is" rather than as every other question in the list.
 * Ordered longest-first: the loop takes the first match, so a longer opener
 * must be offered before a shorter one it contains.
 */
const PREAMBLE = [
  "can you please tell me",
  "could you please tell me",
  "can you tell me",
  "could you tell me",
  "can you explain",
  "could you explain",
  "please tell me",
  "i want to know",
  "i would like to know",
  "tell me about",
  "tell me",
  "please",
];

/**
 * Derive a conversation title from its first question.
 *
 * Deterministic and side-effect free, so it is cheap to test — which matters,
 * because the failure mode is a rail full of entries that all read the same.
 */
export function titleFromQuestion(question: string): string {
  // Collapse whitespace first: a pasted question may be hard-wrapped.
  let text = question.replace(/\s+/g, " ").trim();

  // Take the first sentence. A question with three sentences of context has
  // one of them that names the subject, and it is almost always the first.
  const sentence = /^(.+?[.?!])\s+\S/.exec(text);
  if (sentence && sentence[1].length >= 12) text = sentence[1];

  // Strip a leading opener, case-insensitively, then re-capitalise.
  const lowered = text.toLowerCase();
  for (const opener of PREAMBLE) {
    if (lowered.startsWith(opener)) {
      text = text.slice(opener.length).trim();
      break;
    }
  }

  // Trailing punctuation is noise in a list. A question mark included: every
  // entry would end in one, so it distinguishes nothing.
  text = text.replace(/[\s.?!,;:]+$/, "").trim();

  if (text.length === 0) return "New conversation";

  if (text.length > MAX_LENGTH) {
    // Cut on a word boundary, and only accept the boundary if it leaves a
    // useful amount of the question. Mid-word truncation reads as corruption.
    const clipped = text.slice(0, MAX_LENGTH);
    const lastSpace = clipped.lastIndexOf(" ");
    text = (lastSpace > MAX_LENGTH * 0.6 ? clipped.slice(0, lastSpace) : clipped)
      .replace(/[\s.,;:]+$/, "")
      .concat("…");
  }

  // Sentence case, and only the first character: the rest of the question may
  // legitimately contain capitals — party names, defined terms, part numbers.
  return text.charAt(0).toUpperCase() + text.slice(1);
}
