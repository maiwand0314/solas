ALTER TABLE "messages" ADD COLUMN "client_message_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "partial_output" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_client_message_id_unique" ON "messages" USING btree ("client_message_id");