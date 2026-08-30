import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import { chunks, documents } from "@/db/schema";

/**
 * THE LEXICAL CHANNEL — Postgres full-text search over `chunks.tsv`.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS AT ALL, GIVEN THERE IS A VECTOR INDEX
 *
 * Because embeddings are bad at exactly the things legal and clinical
 * documents are made of. A bi-encoder maps text to a point in a semantic
 * space, and that space is built from meaning — which is precisely the wrong
 * tool for a token that carries no meaning at all:
 *
 *   - clause numbers: "7.3", "Article 14(b)", "§ 1983"
 *   - drug names: "apixaban", "semaglutide"
 *   - identifiers: case numbers, ISO codes, part numbers, defined terms
 *   - rare proper nouns the model never saw in training
 *
 * Ask "what does clause 7.3 say about termination?" and the dense channel
 * returns passages about termination — all of them, ranked by how much they
 * sound like the question. It has no way to prefer the one that literally
 * contains "7.3", because "7.3" and "7.4" are near-identical points in
 * embedding space. Lexical search has the opposite blind spot and the opposite
 * strength: it cannot tell that "notice period" and "days of warning" are
 * related, but it finds "7.3" instantly and exactly.
 *
 * Fusing the two is not belt-and-braces. Each covers the other's failure mode,
 * and the failures are systematic rather than random — which is why this is a
 * channel and not a fallback.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE OWNERSHIP FILTER
 *
 * `chunks` has no `user_id` of its own; it reaches its owner in one hop
 * through `documents`. So this query JOINS documents and filters on
 * `user_id` and `deleted_at IS NULL`, exactly as the vector store filters its
 * payload. The document ids have already been ownership-checked by
 * `assertSameEmbeddingSpace` before retrieval calls this — this is the second
 * lock on the same door, and it is here because "the caller already checked"
 * is the sentence that precedes most data leaks.
 */

/** Postgres text search configuration. Must match the generated `tsv` column. */
const TEXT_SEARCH_CONFIG = "english";

export interface LexicalHit {
  chunkId: string;
  /** `ts_rank_cd` output. Unbounded above; NOT comparable to a cosine. */
  score: number;
}

export interface LexicalSearchResult {
  hits: LexicalHit[];
  /**
   * True when the question reduced to an EMPTY tsquery — every term was a
   * stopword, or the input was punctuation. See `searchLexical`.
   */
  queryEmpty: boolean;
  /**
   * True when the strict AND reading found nothing and the OR relaxation was
   * used instead. Surfaced because it changes how the scores should be read:
   * a relaxed hit may match only one term of the question.
   */
  relaxed: boolean;
}

/**
 * Search the lexical channel.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY `websearch_to_tsquery` AND NOT `plainto_tsquery`
 *
 * Because people type questions the way they type into a search box, and
 * `websearch_to_tsquery` is the only one of Postgres's parsers that reads them
 * that way. It understands:
 *
 *   "notice period"   a quoted phrase — the words adjacent, in that order
 *   termination -tax  negation — passages about termination but not tax
 *   a or b            explicit alternation
 *
 * `plainto_tsquery` ANDs every term and silently ignores quotes and minus
 * signs, so a user who types a phrase in quotes gets no indication that the
 * quotes did nothing. And unlike `to_tsquery`, `websearch_to_tsquery` never
 * raises a syntax error on arbitrary input — an unbalanced quote or a stray
 * `&` is interpreted, not rejected. For a field a user types freely into, "does
 * something sensible with anything" matters more than expressive power.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THERE ARE TWO PASSES, AND WHY THE SECOND ONE MATTERS MORE
 *
 * `websearch_to_tsquery` ANDs every term. Measured on a real passage:
 *
 *   question: "What are the requirements for part number ZX-4471-Q?"
 *   tsquery:  'requir' & 'part' & 'number' & 'zx' <-> '-4471' <-> 'q'
 *   passage:  "...units conforming to part number ZX-4471-Q as set out in
 *              Schedule D..."
 *   result:   NO MATCH
 *
 * The passage contains the part number, "part", and "number" — everything that
 * mattered — and is rejected because it does not also contain the word
 * "requirements". That is correct behaviour for a search BOX, where the user is
 * filtering and expects every word to count. It is close to useless for a
 * retrieval CHANNEL, because a natural question almost never has all of its
 * content words inside the passage that answers it. Left strict, this channel
 * would return nothing for most real questions and hybrid search would quietly
 * degrade to dense-only — the exact failure the channel exists to prevent, and
 * an invisible one, since an empty channel looks the same as an unhelpful one.
 *
 * So: STRICT FIRST, RELAXED IF THAT FINDS NOTHING.
 *
 *   1. The query exactly as `websearch_to_tsquery` parsed it. When the user's
 *      terms really are all present, they get precision, and quoted phrases and
 *      negation behave exactly as typed.
 *   2. If that matched nothing, the same parsed query with its top-level ANDs
 *      turned into ORs. Phrase operators (`<->`) survive, so a quoted phrase
 *      stays a phrase. `ts_rank_cd` then does the work it is good at: a passage
 *      matching the rare part number outranks one matching only "requirements".
 *
 * The relaxation is SKIPPED when the query contains a negation, because
 * `a & !b` and `a | !b` mean different things — the second matches every
 * passage that merely lacks `b`, turning an exclusion into a wildcard. A user
 * who typed a minus sign gets the strict reading or nothing.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE EMPTY TSQUERY
 *
 * `websearch_to_tsquery('english', 'what about it?')` is EMPTY — every word is
 * a stopword — and so is any input that is only punctuation. An empty tsquery
 * matches nothing, which is correct but indistinguishable from "these documents
 * do not contain that", and those two deserve different answers from the
 * interface: one is "your question has no words to search for", the other is
 * "these documents do not mention it".
 *
 * (Note how narrow the line is: "what about the ones?" is NOT empty, because
 * "ones" survives stemming as 'one'. So this cannot be decided by inspecting
 * the string in JavaScript — only Postgres knows, which is why `numnode` is
 * asked rather than guessed at.)
 *
 * So the node count is checked, and reported separately. `numnode(...) > 0` in
 * the WHERE also short-circuits the scan for a query that cannot match
 * anything anyway.
 */
export async function searchLexical(params: {
  userId: string;
  documentIds: string[];
  query: string;
  limit: number;
}): Promise<LexicalSearchResult> {
  const { userId, documentIds, query, limit } = params;

  if (documentIds.length === 0) {
    return { hits: [], queryEmpty: false, relaxed: false };
  }

  // Parsed once. Everything below is a different way of reading this.
  const strict = sql`websearch_to_tsquery(${TEXT_SEARCH_CONFIG}, ${query})`;

  /**
   * The same parsed query with top-level ANDs turned into ORs.
   *
   * Done as a text substitution on the tsquery's own output because Postgres
   * has no function that rewrites an operator in place. Only the exact string
   * " & " is replaced, so phrase operators (" <-> ") are untouched and quoted
   * phrases stay phrases. `strpos(..., '!') = 0` is the negation guard — with a
   * negation present this evaluates to the strict query unchanged.
   */
  const relaxed = sql`(
    case
      when strpos(${strict}::text, '!') = 0
        then replace(${strict}::text, ' & ', ' | ')::tsquery
      else ${strict}
    end
  )`;

  const run = async (tsquery: typeof strict): Promise<LexicalHit[]> => {
    // ts_rank_cd is COVER DENSITY ranking: it rewards passages where the query
    // terms appear close together, not merely often. For a corpus of ~300-token
    // passages that is the more useful signal — two terms in the same sentence
    // means something that two terms 200 words apart does not.
    const score = sql<number>`ts_rank_cd(${chunks.tsv}, ${tsquery})`;

    const rows = await db
      .select({ chunkId: chunks.id, score })
      .from(chunks)
      .innerJoin(documents, eq(documents.id, chunks.documentId))
      .where(
        and(
          // THE OWNERSHIP FILTER. See the header.
          eq(documents.userId, userId),
          isNull(documents.deletedAt),
          inArray(chunks.documentId, documentIds),
          // Skip the scan entirely when the query has no searchable terms.
          sql`numnode(${tsquery}) > 0`,
          // The GIN index on tsv serves this predicate.
          sql`${chunks.tsv} @@ ${tsquery}`,
        ),
      )
      .orderBy(desc(score))
      .limit(limit);

    return rows.map((row) => ({ chunkId: row.chunkId, score: row.score }));
  };

  // PASS 1 — exactly what the user typed.
  const exact = await run(strict);
  if (exact.length > 0) {
    return { hits: exact, queryEmpty: false, relaxed: false };
  }

  // PASS 2 — the OR reading. See the header for why this is the pass that
  // carries most real questions.
  const loose = await run(relaxed);
  if (loose.length > 0) {
    return { hits: loose, queryEmpty: false, relaxed: true };
  }

  // Nothing at all. Ask WHY — "no searchable terms" and "no matches" look
  // identical from here but mean different things to the person who asked. One
  // extra round trip, only on the path where there is nothing to return anyway.
  const [nodes] = await db.execute<{ nodes: number }>(
    sql`select numnode(${strict})::int as nodes`,
  );

  return {
    hits: [],
    queryEmpty: (nodes?.nodes ?? 0) === 0,
    relaxed: false,
  };
}
