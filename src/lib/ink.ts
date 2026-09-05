/**
 * THE HIGHLIGHTER INKS — the entire chromatic vocabulary of the application.
 *
 * The organizing law of the design system is: IF IT IS COLOURED, IT IS A
 * CITATION. Chrome is monochrome. These four inks appear on the page (as a 26%
 * band with a full-strength underline) and on the chips that point at the page,
 * and nowhere else.
 *
 * One ink is assigned per SOURCE DOCUMENT in a conversation, cycling in this
 * order. The assignment is positional, not random: the first document in the
 * conversation's scope is always citrine, so a reader learns "yellow = the
 * contract" within one answer and the mapping does not move under them.
 */

export const INKS = ["citrine", "rose", "jade", "azure"] as const;

export type InkName = (typeof INKS)[number];

/** The CSS custom property reference for an ink, for inline `--ink` styles. */
export function inkVar(ink: InkName): string {
  return `var(--ink-${ink})`;
}

/**
 * The ink for the nth document in a conversation's scope. Wraps after four —
 * a conversation over more than four documents reuses colours, which is a
 * deliberate trade: four distinguishable highlighter colours is already the
 * limit of what a reader can hold, and adding a fifth hue would weaken all of
 * them. Beyond four, the citation chip's document title carries the identity.
 */
export function inkForIndex(index: number): InkName {
  return INKS[index % INKS.length];
}

/**
 * Build the positional document -> ink map for a conversation.
 * `documentIds` must be in the conversation's stable scope order.
 */
export function inkMap(documentIds: string[]): Map<string, InkName> {
  return new Map(documentIds.map((id, index) => [id, inkForIndex(index)]));
}

/**
 * The document order a conversation's inks are assigned from.
 *
 * The conversation's scope is the source of truth, but it is not the whole
 * story: scope can change mid-thread, and an answer given before a document was
 * removed still has chips pointing at it. Those chips must keep a colour, so
 * any document that was cited but is no longer in scope is APPENDED, in first-
 * appearance order, after the current scope.
 *
 * TRADE, STATED PLAINLY: because assignment is positional, removing a document
 * from the middle of the scope shifts the ink of every document after it. The
 * alternative — a stored per-conversation colour assignment that survives
 * removal — is a table and a migration to keep four colours stable across an
 * action most users will never take. Adding documents, which is the common
 * case, never disturbs an existing assignment: retained ids keep their index
 * and new ones land at the end.
 */
export function inkOrder(scopeIds: string[], citedIds: string[]): string[] {
  const order: string[] = [];
  const seen = new Set<string>();

  for (const id of [...scopeIds, ...citedIds]) {
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }

  return order;
}
