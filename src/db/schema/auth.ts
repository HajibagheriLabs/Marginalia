import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Better Auth core tables.
 *
 * Two conventions here are load-bearing and must not be "tidied up":
 *
 *  1. The exported names are PLURAL (`users`, not `user`). Better Auth's
 *     Drizzle adapter looks the table up as `schema[modelName]`, and with
 *     `usePlural: true` it appends an "s" to its internal model name. Pair
 *     these tables with `drizzleAdapter(db, { provider: "pg", usePlural: true })`.
 *
 *  2. The TypeScript property keys are camelCase while the SQL columns are
 *     snake_case. The adapter indexes the Drizzle table object by property key
 *     using Better Auth's own field names, which are camelCase; the SQL column
 *     name underneath is free, and snake_case keeps these tables consistent
 *     with the rest of the schema. Renaming a property key breaks auth at
 *     runtime; renaming a SQL column does not.
 *
 * Ids are uuid with a database default, so Better Auth must be configured with
 * `advanced: { database: { generateId: false } }` to let Postgres mint them.
 *
 * Shape verified against better-auth 1.7.1. Note that `accounts.issuer` and the
 * unique `(issuer, account_id)` index are part of the current core schema.
 */

/** The account owner. Every user-owned table reaches user_id back to here. */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** user_id path: direct. */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)],
);

/**
 * Credentials and linked providers. For this project only the email + password
 * flow is used, which stores a hash in `password`; the OAuth token columns stay
 * null but are part of Better Auth's expected shape.
 *
 * user_id path: direct.
 */
export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issuer: text("issuer").notNull(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("accounts_issuer_account_id_idx").on(
      table.issuer,
      table.accountId,
    ),
    index("accounts_user_id_idx").on(table.userId),
  ],
);

/**
 * Short-lived tokens for email verification and password reset.
 *
 * user_id path: none — rows are keyed by `identifier` (an email address), not
 * by user id, because a verification can exist before its user does.
 */
export const verifications = pgTable(
  "verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("verifications_identifier_idx").on(table.identifier)],
);

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] }),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Verification = typeof verifications.$inferSelect;
export type NewVerification = typeof verifications.$inferInsert;
