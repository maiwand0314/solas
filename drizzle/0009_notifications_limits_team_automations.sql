CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"task_id" uuid,
	"automation_id" uuid,
	"tool_call_id" uuid,
	"conversation_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_kind_valid" CHECK ("notifications"."kind" in ('task_failed', 'task_interrupted', 'automation_missed', 'automation_skipped', 'automation_paused', 'approval_requested', 'approval_expired', 'approval_rejected'))
);
--> statement-breakpoint
ALTER TABLE "automation_occurrences" DROP CONSTRAINT "automation_occurrences_reason_valid";--> statement-breakpoint
ALTER TABLE "automations" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "team_id" uuid;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "max_runs_per_day" integer;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "max_duration_ms" integer;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "allow_overlap" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "pause_after_failures" integer;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "paused_reason" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "max_duration_ms" integer;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tool_call_id_tool_calls_id_fk" FOREIGN KEY ("tool_call_id") REFERENCES "public"."tool_calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_key_unique" ON "notifications" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "notifications_inbox_idx" ON "notifications" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("occurred_at") WHERE "notifications"."read_at" is null;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automations_team_id_idx" ON "automations" USING btree ("team_id");--> statement-breakpoint
ALTER TABLE "automation_occurrences" ADD CONSTRAINT "automation_occurrences_reason_valid" CHECK ("automation_occurrences"."reason" is null or "automation_occurrences"."reason" in ('overlap', 'agent_unavailable', 'usage_limit', 'concurrency_limit', 'daily_limit', 'automation_daily_limit', 'team_unavailable', 'paused_after_failures'));--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_agent_xor_team" CHECK (("automations"."agent_id" is null) <> ("automations"."team_id" is null));--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_max_runs_per_day_valid" CHECK ("automations"."max_runs_per_day" is null or "automations"."max_runs_per_day" >= 1);--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_max_duration_valid" CHECK ("automations"."max_duration_ms" is null or "automations"."max_duration_ms" >= 60000);--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_pause_after_failures_valid" CHECK ("automations"."pause_after_failures" is null or "automations"."pause_after_failures" >= 1);