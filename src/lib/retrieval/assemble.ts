import { countTokens } from "@/lib/ingest/chunk";

import type { RetrievalCandidate, RetrievedPassage } from "./types";

/**
 * CONTEXT ASSEMBLY — turning a ranked list into the thing the model reads.
 *
 * Four steps, in this order, and the order matters:
 *
 *   1. drop candidates below the relevance floor
 *   2. take the top k
 *   3. merge chunks that overlap or adjoin
 *   4. cap the total token budget
 *
 * Filtering before merging, because merging a passage that should have been
 * dropped drags it into the context attached to one that earned its place.
 * Capping last, because the cap is about what fits, and what fits can only be
 * known once the merges have happened.
 */

export const ASSEMBLY = {
  /**
   * How many passages reach the model. The pipeline targets 6–8.
   *
   * The ceiling is not context size — 8 passages is ~2,500 tokens and any
   * modern model has room for far more. It is attention. Past roughly this
   * many candidate passages, recall of any individual one starts to fall, and
   * the failure is the expensive kind: the answer is present in the context
   * and the model does not use it, producing a confident "the documents do not
   * say" with the passage sitting three positions down. More context is not
   * more information.
   */
  k: 8,

  /**
   * The relevance floor, as a fraction of the top candidate's fused score.
   *
   * RELATIVE rather than absolute, because an RRF score has no intrinsic
   * meaning — it is a function of ranks, so its scale depends only on how many
   * channels found the passage, never on how good the match was. The best
   * possible score is 2/(K+1) ≈ 0.0328 for any query, whether the corpus
   * answers it perfectly or not at all. An absolute threshold on that number
   * would be a threshold on "how many channels agreed", not on relevance.
   *
   * Relative to the top result, it means something usable: "much worse than
   * the best thing we found". 0.3 keeps anything a single channel ranked
   * reasonably (1/(60+1) = 0.0164 against a two-channel top of 0.0328 is 0.5,
   * comfortably above) and drops the long tail a single channel ranked 40th.
   */
  minRrfRatio: 0.3,

  /**
   * The floor when a cross-encoder has scored the candidates.
   *
   * Absolute, because unlike an RRF score a cross-encoder logit DOES have
   * intrinsic meaning: it is trained to separate relevant from irrelevant, and
   * 0 is roughly where it puts the boundary. Measured on this model, a passage
   * that answers the question scores about +7 and an unrelated passage from the
   * same document about -11, so the gap around zero is wide and the exact value
   * is not delicate.
   *
   * This is what lets reranking say "none of these are relevant" — something
   * RRF structurally cannot do, since it always ranks whatever it was given.
   */
  minRerankScore: 0,

  /**
   * Hard cap on passage tokens handed to the model.
   *
   * At ~300 tokens a chunk, k=8 lands near 2,400, so this is slack rather than
   * a constraint in the normal case — it exists for the abnormal one, where
   * merging joins several long adjacent chunks into one large passage.
   *
   * Sized to leave a working answer within a modest context window once the
   * system prompt, the conversation history, and the generated answer are
   * added. Kept well clear of any model's limit on purpose: the point is not
   * to fill the window, it is to stop a pathological document from crowding
   * out the question.
   */
  maxContextTokens: 4_000,
} as const;

export interface AssembleOptions {
  k?: number;
  /** True when a cross-encoder scored the candidates; selects the floor. */
  reranked?: boolean;
  minRrfRatio?: number;
  minRerankScore?: number;
  maxContextTokens?: number;
}

/**
 * The score a candidate is ordered and filtered by.
 *
 * The rerank score wins where it exists — it is the more accurate signal, and
 * that is the entire reason for paying for it. Candidates outside the rerank
 * window keep their RRF score and are never promoted above a reranked one,
 * which is handled by the caller ordering reranked candidates first.
 */
function rankingScore(candidate: RetrievalCandidate): number {
  return candidate.rerankScore ?? candidate.rrfScore;
}

/**
 * Should this candidate's text reach the model?
 *
 * Note what is NOT here: a rule that always keeps at least one passage. If
 * every candidate is below the floor, the correct context is EMPTY, and the
 * correct answer is "nothing in these documents addresses that". Handing the
 * model the least-bad passage instead is how a grounded system starts
 * answering from passages that do not contain the answer — the citation looks
 * valid, the marker resolves, and the claim is invented. "These documents
 * don't answer that" is a correct response and is covered by the eval set.
 */
function passesFloor(
  candidate: RetrievalCandidate,
  topRrf: number,
  options: Required<Omit<AssembleOptions, "k" | "reranked">> & {
    reranked: boolean;
  },
): boolean {
  if (options.reranked && candidate.rerankScore !== null) {
    return candidate.rerankScore >= options.minRerankScore;
  }
  if (topRrf <= 0) return true;
  return candidate.rrfScore / topRrf >= options.minRrfRatio;
}

/**
 * Two candidates whose text overlaps or runs straight on from one another.
 *
 * This is a direct consequence of the 15% ingest overlap: neighbouring chunks
 * SHARE SENTENCES by construction. Retrieving both and passing both would
 * spend context on a duplicate and, worse, offer the model the same sentence
 * under two different citation markers — so an answer could cite [3] and [4]
 * for one fact and look like it had two sources.
 *
 * Overlap is decided on character offsets rather than on ordinals alone,
 * because offsets are the ground truth: `charStart <= previous.charEnd` is
 * exactly "these two share text". Adjacent ordinals with a small gap are
 * merged too — the gap is the whitespace between blocks, and joining across it
 * restores a passage the chunker split only because of a token budget.
 */
function shouldMerge(
  previous: RetrievalCandidate,
  next: RetrievalCandidate,
): boolean {
  if (previous.documentId !== next.documentId) return false;
  if (next.ordinal !== previous.ordinal + 1) return false;
  // Overlapping, or separated by nothing but the whitespace between blocks.
  return next.charStart <= previous.charEnd;
}

/**
 * Join two overlapping chunk texts without repeating the shared span.
 *
 * Both texts are exact slices of the document, so the overlap length is
 * `previous.charEnd - next.charStart` and the join is the tail of `next` past
 * that point. The result is character-for-character what the document says
 * across the combined range — which is what keeps the merged passage citable
 * and highlightable.
 */
function joinTexts(
  previous: { text: string; charEnd: number },
  next: { text: string; charStart: number },
): string {
  const overlap = previous.charEnd - next.charStart;
  if (overlap <= 0) {
    // Adjacent but not overlapping: the gap is inter-block whitespace, which
    // the chunker trimmed off both sides. One blank line restores the
    // paragraph break the document had.
    return `${previous.text}\n\n${next.text}`;
  }
  if (overlap >= next.text.length) return previous.text;
  return previous.text + next.text.slice(overlap);
}

/**
 * Build the final context.
 *
 * Mutates `used` on the candidates it keeps, so the trace and the context can
 * never disagree about what the model was shown.
 */
export function assemble(
  ranked: RetrievalCandidate[],
  options: AssembleOptions = {},
): { passages: RetrievedPassage[]; contextTokens: number } {
  const settings = {
    k: options.k ?? ASSEMBLY.k,
    reranked: options.reranked ?? false,
    minRrfRatio: options.minRrfRatio ?? ASSEMBLY.minRrfRatio,
    minRerankScore: options.minRerankScore ?? ASSEMBLY.minRerankScore,
    maxContextTokens: options.maxContextTokens ?? ASSEMBLY.maxContextTokens,
  };

  if (ranked.length === 0) return { passages: [], contextTokens: 0 };

  const topRrf = Math.max(...ranked.map((candidate) => candidate.rrfScore));

  // 1 & 2 — floor, then top k.
  const selected = ranked
    .filter((candidate) => passesFloor(candidate, topRrf, settings))
    .slice(0, settings.k);

  if (selected.length === 0) return { passages: [], contextTokens: 0 };

  // 3 — merge. Sorted into DOCUMENT ORDER first, because adjacency is a fact
  // about the document and not about the ranking; two chunks that adjoin are
  // only recognisable as neighbours when they sit next to each other.
  const inDocumentOrder = [...selected].sort((a, b) =>
    a.documentId !== b.documentId
      ? a.documentId.localeCompare(b.documentId)
      : a.ordinal - b.ordinal,
  );

  interface Merged {
    members: RetrievalCandidate[];
    text: string;
    charStart: number;
    charEnd: number;
  }

  const merged: Merged[] = [];
  for (const candidate of inDocumentOrder) {
    const open = merged[merged.length - 1];
    const previous = open?.members[open.members.length - 1];

    if (open && previous && shouldMerge(previous, candidate)) {
      open.text = joinTexts(
        { text: open.text, charEnd: open.charEnd },
        candidate,
      );
      open.charEnd = Math.max(open.charEnd, candidate.charEnd);
      open.members.push(candidate);
    } else {
      merged.push({
        members: [candidate],
        text: candidate.text,
        charStart: candidate.charStart,
        charEnd: candidate.charEnd,
      });
    }
  }

  // Back into relevance order: a merged passage is as relevant as its best
  // constituent, since that is the one that earned it a place.
  const best = (group: Merged) =>
    Math.max(...group.members.map(rankingScore));
  merged.sort((a, b) => best(b) - best(a));

  // 4 — the token cap. Applied in relevance order, so what gets dropped is
  // always the least relevant thing rather than whatever happened to be last.
  const passages: RetrievedPassage[] = [];
  let contextTokens = 0;

  for (const group of merged) {
    const tokenCount = countTokens(group.text);
    if (contextTokens + tokenCount > settings.maxContextTokens) continue;

    const members = group.members;
    const primary = members.reduce((a, b) =>
      rankingScore(b) > rankingScore(a) ? b : a,
    );
    for (const member of members) member.used = true;

    passages.push({
      marker: passages.length + 1,
      chunkIds: members.map((member) => member.chunkId),
      primaryChunkId: primary.chunkId,
      documentId: primary.documentId,
      documentTitle: primary.documentTitle,
      text: group.text,
      tokenCount,
      pageFrom: Math.min(...members.map((member) => member.pageFrom)),
      pageTo: Math.max(...members.map((member) => member.pageTo)),
      charStart: group.charStart,
      charEnd: group.charEnd,
      // The breadcrumb of the passage's best constituent; a merged passage
      // spans one section by construction, since merging requires adjacency.
      sectionPath: primary.sectionPath,
      score: best(group),
    });

    contextTokens += tokenCount;
  }

  return { passages, contextTokens };
}
