import { relations, sql, type SQL } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { documentStatus } from "./enums";
import { users } from "./auth";

/**
 * Postgres `tsvector`. Drizzle has no built-in column type for it, so the
 * lexical retrieval channel gets a thin custom type. The value is never read
 * or written from application code — the column is GENERATED — but declaring
 * it here is what lets drizzle-kit emit and diff it.
 */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});

/**
 * An uploaded source document.
 *
 * user_id path: DIRECT. This is the root of document ownership — every other
 * document-side table reaches the owner through exactly one hop to here.
 *
 * Soft-deleted via `deleted_at`; this is the only table in the schema with a
 * soft delete. Every query must filter `deleted_at IS NULL`.
 */
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    title: text("title").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),

    // Vercel Blob. The file is uploaded client-side; only these pointers are
    // stored, never the bytes.
    blobUrl: text("blob_url").notNull(),
    blobPathname: text("blob_pathname").notNull(),

    pageCount: integer("page_count"),

    // The ingestion state machine.
    status: documentStatus("status").notNull().default("uploaded"),
    // Which stage the document died in, so "Retry" resumes from exactly there.
    failedStage: documentStatus("failed_stage"),
    errorMessage: text("error_message"),

    // Which embedding space this document lives in. Searching across documents
    // with different values here is refused rather than silently wrong — the
    // vectors are not comparable.
    embeddingModel: text("embedding_model"),
    embeddingDim: integer("embedding_dim"),

    tokenCount: integer("token_count"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    // The library rail: this user's documents, newest first.
    index("documents_user_id_created_at_idx").on(
      table.userId,
      table.createdAt.desc(),
    ),
  ],
);

/**
 * Extracted text for one page, plus that page's offsets into the document's
 * concatenated page text. Those offsets are how a chunk's char_start/char_end
 * are resolved back to a page for highlighting.
 *
 * user_id path: ONE HOP — document_pages.document_id -> documents.user_id.
 */
export const documentPages = pgTable(
  "document_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),

    pageNumber: integer("page_number").notNull(),
    text: text("text").notNull(),
    charStart: integer("char_start").notNull(),
    charEnd: integer("char_end").notNull(),
  },
  (table) => [
    // Serves both the uniqueness rule and the (document_id, page_number)
    // lookup — a unique index is an index.
    uniqueIndex("document_pages_document_id_page_number_idx").on(
      table.documentId,
      table.pageNumber,
    ),
  ],
);

/**
 * A retrievable passage. `text` is the ORIGINAL chunk text — the context
 * header ("<title> — <section path>") is prepended only for embedding and is
 * never stored or displayed here.
 *
 * user_id path: ONE HOP — chunks.document_id -> documents.user_id.
 */
export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),

    ordinal: integer("ordinal").notNull(),
    text: text("text").notNull(),
    tokenCount: integer("token_count").notNull(),

    pageFrom: integer("page_from").notNull(),
    pageTo: integer("page_to").notNull(),
    charStart: integer("char_start").notNull(),
    charEnd: integer("char_end").notNull(),

    // Heading breadcrumb, e.g. "7. Termination › 7.2 For convenience".
    sectionPath: text("section_path"),

    // Denormalized from the document so a mixed-embedding-space search can be
    // refused without a join.
    embeddingModel: text("embedding_model"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    /**
     * The lexical retrieval channel. GENERATED ALWAYS ... STORED, so it can
     * never drift from `text`.
     *
     * The regconfig is written as the literal 'english' rather than relying on
     * default_text_search_config: the two-argument form of to_tsvector is
     * IMMUTABLE, which Postgres requires for a generated column, and the
     * one-argument form is not.
     */
    tsv: tsvector("tsv").generatedAlwaysAs(
      (): SQL => sql`to_tsvector('english', "text")`,
    ),
  },
  (table) => [
    // Reading a document's chunks back in order.
    index("chunks_document_id_ordinal_idx").on(table.documentId, table.ordinal),
    // The lexical half of hybrid retrieval.
    index("chunks_tsv_idx").using("gin", table.tsv),
  ],
);

export const documentsRelations = relations(documents, ({ one, many }) => ({
  user: one(users, { fields: [documents.userId], references: [users.id] }),
  pages: many(documentPages),
  chunks: many(chunks),
}));

export const documentPagesRelations = relations(documentPages, ({ one }) => ({
  document: one(documents, {
    fields: [documentPages.documentId],
    references: [documents.id],
  }),
}));

export const chunksRelations = relations(chunks, ({ one }) => ({
  document: one(documents, {
    fields: [chunks.documentId],
    references: [documents.id],
  }),
}));

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type DocumentPage = typeof documentPages.$inferSelect;
export type NewDocumentPage = typeof documentPages.$inferInsert;
export type Chunk = typeof chunks.$inferSelect;
export type NewChunk = typeof chunks.$inferInsert;

/** The ingestion state machine's states, as a union type. */
export type DocumentStatus = (typeof documentStatus.enumValues)[number];
