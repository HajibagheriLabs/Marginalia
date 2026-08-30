/**
 * RECIPROCAL RANK FUSION.
 *
 * Two channels return two ranked lists. This merges them into one.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY RANKS AND NOT SCORES
 *
 * The obvious approach — normalise both score sets and add them — does not
 * work here, and the reason is worth stating because it looks like it should.
 * A cosine similarity is bounded in [-1, 1] and clusters tightly: the gap
 * between the best and the tenth-best passage is often 0.04. `ts_rank_cd` is
 * unbounded above, depends on term frequency and document length, and routinely
 * spans two orders of magnitude across one result set. There is no fixed
 * transform between them, and min-max normalising each list makes the numbers
 * comparable only by construction — it rescales whatever spread each query
 * happened to produce, so a query where dense was uniformly unsure gets the
 * same top score as one where it was certain.
 *
 * Ranks discard the magnitudes and keep the only thing both channels agree on:
 * the ordering. Position 1 in each list means the same thing.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE FORMULA
 *
 *     score(d) = Σ  1 / (K + rank_i(d))
 *                i
 *
 * over the channels that returned `d`, with ranks 1-based. A passage found at
 * position 1 by both channels scores 2/(K+1); one found only by dense at
 * position 1 scores 1/(K+1). Agreement is rewarded without either channel
 * being able to veto the other.
 */

/**
 * THE K CONSTANT, and why it is 60.
 *
 * K flattens the curve. Without it, score would be 1/rank: rank 1 scores 1.0,
 * rank 2 scores 0.5, rank 3 scores 0.33. A single channel's first place would
 * then outweigh anything the other channel could say — 1.0 against a best
 * possible 0.5 + 0.33 — so fusion would collapse into "whichever channel is
 * most confident wins", which is the behaviour hybrid search exists to avoid.
 *
 * With K = 60 the same three ranks score 0.0164, 0.0161, 0.0159. The gaps are
 * small, so a passage ranked 3rd by both channels (0.0318) beats one ranked 1st
 * by only one (0.0164). That is the intended bias: corroboration across two
 * different notions of relevance is stronger evidence than one channel being
 * sure.
 *
 * 60 is from Cormack, Clarke & Buettcher (2009), who found it robust across
 * TREC collections without per-dataset tuning. It is not sacred — it is the
 * first thing to sweep once the eval harness exists, since the right value
 * depends on how deep the useful results go in each channel, and that is a
 * property of this corpus rather than of the formula.
 *
 * Lower K sharpens the top of each list (more winner-take-all); higher K
 * flattens further and rewards agreement even more.
 */
export const RRF_K = 60;

/** One channel's ranked output: chunk ids, best first. */
export interface RankedList {
  /** Chunk ids in rank order. Position 0 is rank 1. */
  ids: string[];
}

export interface FusedEntry {
  id: string;
  /** The fused score. Higher is better. */
  score: number;
  /** 1-based rank in each input list, or null where the list omitted it. */
  ranks: Array<number | null>;
}

/**
 * Fuse any number of ranked lists.
 *
 * Deliberately generic over chunk ids rather than over passage objects: fusion
 * is a fact about orderings, and keeping it that way is what makes it testable
 * against hand-computed fixtures without constructing a database row.
 *
 * Ties are broken by id so the output is deterministic. Two passages with
 * identical fused scores is not a rare edge — it happens whenever both are
 * found by one channel only, at adjacent ranks in different queries — and a
 * non-deterministic order there would make the trace unreproducible and the
 * eval harness noisy.
 */
export function fuse(lists: RankedList[], k: number = RRF_K): FusedEntry[] {
  // id -> its 1-based rank in each list, null where absent.
  const ranks = new Map<string, Array<number | null>>();

  lists.forEach((list, listIndex) => {
    list.ids.forEach((id, position) => {
      let entry = ranks.get(id);
      if (!entry) {
        entry = new Array<number | null>(lists.length).fill(null);
        ranks.set(id, entry);
      }
      // Only the FIRST occurrence counts, so a list that repeats an id cannot
      // score it twice.
      if (entry[listIndex] === null) entry[listIndex] = position + 1;
    });
  });

  const fused: FusedEntry[] = [];
  for (const [id, entry] of ranks) {
    let score = 0;
    for (const rank of entry) if (rank !== null) score += 1 / (k + rank);
    fused.push({ id, score, ranks: entry });
  }

  return fused.sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.id.localeCompare(b.id),
  );
}
