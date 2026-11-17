CREATE TABLE "notification_preferences" (
	"kind" text PRIMARY KEY NOT NULL,
	"enabled" boolean NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_kind_valid" CHECK ("notification_preferences"."kind" in ('task_failed', 'task_interrupted', 'automation_missed', 'automation_skipped', 'automation_paused', 'approval_requested', 'approval_expired', 'approval_rejected'))
);
--> statement-breakpoint
CREATE TABLE "worker_failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" text NOT NULL,
	"step" text NOT NULL,
	"code" text NOT NULL,
	"message" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "worker_failures_step_valid" CHECK ("worker_failures"."step" in ('scheduler', 'notifications', 'recovery', 'queue')),
	CONSTRAINT "worker_failures_code_valid" CHECK ("worker_failures"."code" in ('database_unavailable', 'query_failed', 'timeout', 'unexpected'))
);
--> statement-breakpoint
CREATE TABLE "worker_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"hostname" text NOT NULL,
	"pid" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_heartbeat_at" timestamp with time zone NOT NULL,
	"stopped_at" timestamp with time zone,
	"last_scheduler_ok_at" timestamp with time zone,
	"last_notifications_ok_at" timestamp with time zone,
	"last_recovery_ok_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "worker_failures" ADD CONSTRAINT "worker_failures_worker_id_worker_instances_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."worker_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "worker_failures_worker_idx" ON "worker_failures" USING btree ("worker_id","occurred_at");--> statement-breakpoint
CREATE INDEX "worker_instances_heartbeat_idx" ON "worker_instances" USING btree ("last_heartbeat_at");