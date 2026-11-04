CREATE TABLE "automation_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"trigger" text DEFAULT 'schedule' NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"missed_count" integer DEFAULT 0 NOT NULL,
	"message" text NOT NULL,
	"task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_occurrences_status_valid" CHECK ("automation_occurrences"."status" in ('started', 'missed', 'skipped')),
	CONSTRAINT "automation_occurrences_trigger_valid" CHECK ("automation_occurrences"."trigger" in ('schedule', 'manual')),
	CONSTRAINT "automation_occurrences_reason_matches" CHECK (("automation_occurrences"."status" = 'skipped') = ("automation_occurrences"."reason" is not null)),
	CONSTRAINT "automation_occurrences_reason_valid" CHECK ("automation_occurrences"."reason" is null or "automation_occurrences"."reason" in ('overlap', 'agent_unavailable', 'usage_limit', 'concurrency_limit', 'daily_limit'))
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"agent_id" uuid NOT NULL,
	"instructions" text NOT NULL,
	"schedule" jsonb NOT NULL,
	"time_zone" text DEFAULT 'Europe/Oslo' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"schedule_anchor_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automations_name_not_blank" CHECK (length(trim("automations"."name")) > 0),
	CONSTRAINT "automations_paused_has_no_next_run" CHECK ("automations"."enabled" or "automations"."next_run_at" is null)
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "automation_id" uuid;--> statement-breakpoint
ALTER TABLE "automation_occurrences" ADD CONSTRAINT "automation_occurrences_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_occurrences" ADD CONSTRAINT "automation_occurrences_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_occurrences_once_per_time" ON "automation_occurrences" USING btree ("automation_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "automation_occurrences_automation_idx" ON "automation_occurrences" USING btree ("automation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_occurrences_task_id_unique" ON "automation_occurrences" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "automations_name_lower_unique" ON "automations" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "automations_due_idx" ON "automations" USING btree ("next_run_at") WHERE "automations"."enabled" and "automations"."next_run_at" is not null;--> statement-breakpoint
CREATE INDEX "automations_agent_id_idx" ON "automations" USING btree ("agent_id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_automation_id_idx" ON "tasks" USING btree ("automation_id");