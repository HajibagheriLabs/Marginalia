import { relations } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { usageKind } from "./enums";
import { users } from "./auth";

/**
 * An append-only meter. One row per billable unit of work, so cost can be
 * attributed per user without recomputing it from messages and documents.
 *
 * `quantity` is denominated by `kind`: bytes for an upload, tokens for an
 * embedding, tokens for a completion. `cost_cents` is always integer cents —
 * no floats anywhere near money.
 *
 * user_id path: DIRECT.
 */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    kind: usageKind("kind").notNull(),
    quantity: integer("quantity").notNull(),
    costCents: integer("cost_cents").notNull().default(0),

    /**
     * WHO did the work: "local" for in-process inference, or a model slug for
     * anything billed by a vendor.
     *
     * Exists so the settings page can be honest rather than vague. Embeddings
     * run on this server's CPU, so their monetary cost is genuinely zero — not
     * "too small to show", not estimated at some notional per-token rate.
     * Writing 0 into `cost_cents` without recording WHY it is zero would leave
     * a readout that looks like missing data. With this column it can say
     * "1.2M tokens embedded locally, no API cost", which is the true statement.
     */
    source: text("source"),

    /**
     * Wall-clock milliseconds the work took.
     *
     * For local inference this is the meaningful cost — the function-seconds
     * actually spent — and it is what would turn into money first if this ever
     * outgrew a free tier. Recording it now means the usage page has real data
     * to show instead of a column of zeroes.
     */
    durationMs: integer("duration_ms"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("usage_events_user_id_created_at_idx").on(
      table.userId,
      table.createdAt.desc(),
    ),
  ],
);

export const usageEventsRelations = relations(usageEvents, ({ one }) => ({
  user: one(users, { fields: [usageEvents.userId], references: [users.id] }),
}));

export type UsageEvent = typeof usageEvents.$inferSelect;
export type NewUsageEvent = typeof usageEvents.$inferInsert;

/** Usage event kinds, as a union type. */
export type UsageKind = (typeof usageKind.enumValues)[number];
