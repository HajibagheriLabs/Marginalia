import { relations, sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { messageRole } from "./enums";
import { users } from "./auth";
import { chunks, documents } from "./documents";

/**
 * A thread of questions scoped to a fixed set of documents.
 *
 * `document_ids` is the retrieval scope for the whole conversation and is also
 * what assigns highlighter inks: the four inks cycle in array order, so the
 * ordering of this column is meaningful and must be preserved on write.
 *
 * user_id path: DIRECT.
 */
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    title: text("title"),
    documentIds: uuid("document_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("conversations_user_id_updated_at_idx").on(
      table.userId,
      table.updatedAt.desc(),
    ),
  ],
);

/**
 * One turn. The token, cost, and latency columns are what `usage_events` and
 * the answer footer are built from. Costs are integer cents.
 *
 * user_id path: ONE HOP — messages.conversation_id -> conversations.user_id.
 */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),

    role: messageRole("role").notNull(),
    content: text("content").notNull(),

    // Null on user messages; set on assistant messages.
    model: text("model"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    costCents: integer("cost_cents"),
    latencyMs: integer("latency_ms"),
    finishReason: text("finish_reason"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Replaying a conversation in order.
    index("messages_conversation_id_created_at_idx").on(
      table.conversationId,
      table.createdAt,
    ),
  ],
);

/**
 * A validated citation marker. These rows are written only AFTER the generated
 * answer has been parsed and every marker checked against the passages that
 * were actually retrieved — a marker that maps to nothing is discarded and
 * logged, never persisted.
 *
 * `quoted_text`, `page_from`, and `page_to` are denormalized on purpose: the
 * citation stays readable, and stays a durable record of what was claimed,
 * even if the chunk it pointed at is later replaced.
 *
 * `chunk_id` is nullable with ON DELETE SET NULL rather than CASCADE. Re-
 * ingesting a document replaces its chunks; under CASCADE that would silently
 * delete the citations in every past conversation. Set-null keeps the citation
 * and its quote, and only costs the scroll-to-passage deep link.
 *
 * user_id path: ONE HOP — citations.message_id -> messages -> conversations
 * -> user_id. (Strictly two joins; `message_id` is the single owning FK.)
 */
export const citations = pgTable(
  "citations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),

    // The [n] shown in the answer text.
    marker: integer("marker").notNull(),

    chunkId: uuid("chunk_id").references(() => chunks.id, {
      onDelete: "set null",
    }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),

    pageFrom: integer("page_from").notNull(),
    pageTo: integer("page_to").notNull(),
    quotedText: text("quoted_text"),
  },
  (table) => [
    // A marker number is unique within one answer. `message_id` leads this
    // index, so it also serves the "all citations for this answer" lookup —
    // a separate index on message_id alone would be redundant.
    uniqueIndex("citations_message_id_marker_idx").on(
      table.messageId,
      table.marker,
    ),
  ],
);

/**
 * The retrieval trace: one row per candidate passage considered for one
 * answer, with what each stage scored it. This backs the "Show retrieval"
 * table under every answer — a product feature, not a debug log, so it is
 * written on every answer and kept.
 *
 * Rank and score columns are nullable because a passage can enter the fused
 * set from only one channel: a dense-only hit has no lexical rank, and
 * `rerank_score` is null whenever reranking was skipped.
 *
 * `used` marks the passages that actually entered the final context.
 *
 * user_id path: ONE HOP — retrievals.message_id -> messages -> conversations
 * -> user_id.
 */
export const retrievals = pgTable(
  "retrievals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),

    // Set-null for the same reason as citations.chunk_id: re-ingestion must
    // not erase the trace of answers that were already given.
    chunkId: uuid("chunk_id").references(() => chunks.id, {
      onDelete: "set null",
    }),

    denseRank: integer("dense_rank"),
    denseScore: doublePrecision("dense_score"),
    lexicalRank: integer("lexical_rank"),
    lexicalScore: doublePrecision("lexical_score"),
    rrfScore: doublePrecision("rrf_score"),
    rerankScore: doublePrecision("rerank_score"),

    used: boolean("used").notNull().default(false),
  },
  (table) => [index("retrievals_message_id_idx").on(table.messageId)],
);

export const conversationsRelations = relations(
  conversations,
  ({ one, many }) => ({
    user: one(users, {
      fields: [conversations.userId],
      references: [users.id],
    }),
    messages: many(messages),
  }),
);

export const messagesRelations = relations(messages, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
  citations: many(citations),
  retrievals: many(retrievals),
}));

export const citationsRelations = relations(citations, ({ one }) => ({
  message: one(messages, {
    fields: [citations.messageId],
    references: [messages.id],
  }),
  chunk: one(chunks, { fields: [citations.chunkId], references: [chunks.id] }),
  document: one(documents, {
    fields: [citations.documentId],
    references: [documents.id],
  }),
}));

export const retrievalsRelations = relations(retrievals, ({ one }) => ({
  message: one(messages, {
    fields: [retrievals.messageId],
    references: [messages.id],
  }),
  chunk: one(chunks, { fields: [retrievals.chunkId], references: [chunks.id] }),
}));

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Citation = typeof citations.$inferSelect;
export type NewCitation = typeof citations.$inferInsert;
export type Retrieval = typeof retrievals.$inferSelect;
export type NewRetrieval = typeof retrievals.$inferInsert;

/** Message roles, as a union type. */
export type MessageRole = (typeof messageRole.enumValues)[number];
