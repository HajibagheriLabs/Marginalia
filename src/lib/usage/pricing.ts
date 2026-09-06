/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THE PRICE TABLE. One file, every model, and every price is zero.         │
 * │                                                                          │
 * │ WHY A PRICE TABLE FOR A ZERO-COST APP.                                   │
 * │                                                                          │
 * │ Because the accounting is the portable part. This project runs entirely  │
 * │ on free tiers: every OpenRouter id is validated `:free` at boot, and     │
 * │ embeddings run in this Node process on this server's CPU. So the honest  │
 * │ cost of a completion is 0, the honest cost of an embedding batch is 0,   │
 * │ and every `cost_cents` this app writes is a real measurement rather than │
 * │ a rounded-down estimate.                                                 │
 * │                                                                          │
 * │ It would therefore be entirely possible to write `costCents: 0` at each  │
 * │ call site and delete this file. That is exactly the shortcut that makes  │
 * │ an application impossible to move onto a paid model later: the day the   │
 * │ pool carries a metered slug, cost stops being a constant and every one   │
 * │ of those call sites is a place where a wrong number can be written       │
 * │ silently. With the table, that day is a data change — add the slug, add  │
 * │ its two rates — and nothing else moves. The plumbing that carries a      │
 * │ price from here into `usage_events` and onto the message row is already  │
 * │ built, already tested, and already displayed.                            │
 * │                                                                          │
 * │ WHERE TO CHECK PRICES:                                                   │
 * │   Free pool  https://openrouter.ai/models?max_price=0                    │
 * │   Any model  https://openrouter.ai/api/v1/models — each entry carries    │
 * │              `pricing.prompt` and `pricing.completion` as USD PER TOKEN, │
 * │              as strings. Multiply by 1e6 for the per-million figures     │
 * │              below. Prices change; a delisted `:free` variant is         │
 * │              replaced, never silently upgraded to a paid one.            │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

/**
 * USD per MILLION tokens.
 *
 * Per million rather than per token because that is the unit vendors publish
 * and the unit a human can check against a pricing page. Per-token figures are
 * 1e-7-scale floats that all look alike, and a misplaced decimal in one is
 * invisible.
 */
export interface ModelPrice {
  promptPerMillionUsd: number;
  completionPerMillionUsd: number;
  /** Why this price is what it is. Shown nowhere; read by whoever edits this. */
  note: string;
}

/**
 * Local inference. Not metered by anyone, at any rate.
 *
 * The cost that IS real here is wall-clock compute — function-seconds — and
 * that is recorded on the usage event as `duration_ms` rather than converted
 * into a notional dollar figure. See src/db/schema/usage.ts.
 */
export const LOCAL_PRICE: ModelPrice = {
  promptPerMillionUsd: 0,
  completionPerMillionUsd: 0,
  note: "runs in this Node process via Transformers.js; nothing is metered",
};

/**
 * Every model this app is allowed to call, and what it costs.
 *
 * All zero, and all zero for the same reason: `env.ts` refuses to boot unless
 * every configured OpenRouter id ends in `:free`. A slug that is not in this
 * table is priced by `FREE_SUFFIX_PRICE` below rather than guessed at.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  "nvidia/nemotron-3.5-lightning:free": {
    promptPerMillionUsd: 0,
    completionPerMillionUsd: 0,
    note: "free variant; the configured primary",
  },
  "google/gemma-4-31b-it:free": {
    promptPerMillionUsd: 0,
    completionPerMillionUsd: 0,
    note: "free variant",
  },
  "nvidia/nemotron-3-super-120b-a12b:free": {
    promptPerMillionUsd: 0,
    completionPerMillionUsd: 0,
    note: "free variant",
  },
  "Xenova/bge-small-en-v1.5": LOCAL_PRICE,
  "Xenova/ms-marco-MiniLM-L-6-v2": LOCAL_PRICE,
};

/**
 * Any `:free` slug not listed above.
 *
 * The free pool churns weekly, so an exhaustive list would be stale within a
 * month — the same reasoning that makes `env.ts` check the suffix rather than
 * an allowlist. A `:free` id is free by definition, so this is a fact and not
 * an assumption.
 */
const FREE_SUFFIX_PRICE: ModelPrice = {
  promptPerMillionUsd: 0,
  completionPerMillionUsd: 0,
  note: "`:free` variants are zero-cost by definition; enforced at boot in env.ts",
};

export function priceFor(model: string | null): ModelPrice | null {
  if (!model) return null;
  const known = MODEL_PRICES[model];
  if (known) return known;
  if (model.endsWith(":free")) return FREE_SUFFIX_PRICE;
  // An unpriced, non-free slug. Not reachable while env.ts holds the `:free`
  // rule, and deliberately not defaulted to zero if it ever becomes reachable:
  // a missing price must read as "unknown", never as "free".
  return null;
}

/**
 * What a completion cost, in INTEGER CENTS.
 *
 * Rounded UP, so accounting never under-reports. On the free pool every term
 * is zero and this returns 0 — which is the true cost, not a floor applied to
 * a small number. The rounding only starts mattering the day a paid slug
 * appears in the table, which is the day this function starts earning its
 * keep.
 *
 * Returns null when the model is unknown, so a caller can record "unpriced"
 * rather than write a zero that looks like a measurement.
 */
export function completionCostCents(input: {
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
}): number | null {
  const price = priceFor(input.model);
  if (!price) return null;

  const promptUsd =
    ((input.promptTokens ?? 0) / 1_000_000) * price.promptPerMillionUsd;
  const completionUsd =
    ((input.completionTokens ?? 0) / 1_000_000) * price.completionPerMillionUsd;

  return Math.ceil((promptUsd + completionUsd) * 100);
}

/**
 * "$0.00 · free tier" — the per-message readout, in one place.
 *
 * The dollar figure is shown even though it is zero, because a blank cost
 * column reads as missing data. The qualifier is what makes it a statement
 * rather than a rounding: `$0.00` alone could mean "less than half a cent",
 * and `free tier` says it is exactly nothing.
 */
export function formatCost(costCents: number | null, model: string | null): string {
  if (costCents === null) return "cost unknown";
  const dollars = `$${(costCents / 100).toFixed(2)}`;
  if (costCents === 0 && (model === null || priceFor(model) !== null)) {
    return `${dollars} · free tier`;
  }
  return dollars;
}
