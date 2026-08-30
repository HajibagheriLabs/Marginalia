ALTER TABLE "chunks" ADD COLUMN "indexed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "chunk_count" integer;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
CREATE INDEX "chunks_document_id_indexed_at_idx" ON "chunks" USING btree ("document_id","indexed_at");