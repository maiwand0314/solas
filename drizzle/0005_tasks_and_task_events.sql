CREATE TABLE "task_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "task_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"task_id" uuid NOT NULL,
	"run_id" uuid,
	"type" text NOT NULL,
	"message" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"title" text NOT NULL,
	"instructions" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"result" text,
	"error_code" text,
	"error_message" text,
	"cancel_requested_at" timestamp with time zone,
	"auto_retries_left" integer DEFAULT 1 NOT NULL,
	"client_request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "tasks_status_valid" CHECK ("tasks"."status" in ('queued', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'interrupted')),
	CONSTRAINT "tasks_title_not_blank" CHECK (length(trim("tasks"."title")) > 0),
	CONSTRAINT "tasks_auto_retries_left_valid" CHECK ("tasks"."auto_retries_left" between 0 and 5)
);
--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "conversation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "user_message_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "worker_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "not_before" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_events_task_id_idx" ON "task_events" USING btree ("task_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_client_request_id_unique" ON "tasks" USING btree ("client_request_id");--> statement-breakpoint
CREATE INDEX "tasks_updated_at_idx" ON "tasks" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "tasks_agent_id_idx" ON "tasks" USING btree ("agent_id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_active_per_task" ON "runs" USING btree ("task_id") WHERE "runs"."status" in ('pending', 'running');--> statement-breakpoint
CREATE INDEX "runs_task_id_idx" ON "runs" USING btree ("task_id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_belong_to_conversation_or_task" CHECK (("runs"."task_id" is null and "runs"."conversation_id" is not null and "runs"."user_message_id" is not null)
        or ("runs"."task_id" is not null and "runs"."conversation_id" is null and "runs"."user_message_id" is null));