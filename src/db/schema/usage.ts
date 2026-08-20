import { relations } from "drizzle-orm";
import { index, integer, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

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
