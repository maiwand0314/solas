CREATE TABLE "agent_delegation_targets" (
	"agent_id" uuid NOT NULL,
	"target_agent_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_delegation_targets_agent_id_target_agent_id_pk" PRIMARY KEY("agent_id","target_agent_id"),
	CONSTRAINT "agent_delegation_targets_not_self" CHECK ("agent_delegation_targets"."agent_id" <> "agent_delegation_targets"."target_agent_id")
);
--> statement-breakpoint
CREATE TABLE "task_delegations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_task_id" uuid NOT NULL,
	"parent_run_id" uuid,
	"parent_agent_id" uuid NOT NULL,
	"target_agent_id" uuid NOT NULL,
	"child_task_id" uuid NOT NULL,
	"task_description" text NOT NULL,
	"expected_output" text,
	"request_hash" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"parent_notes" text,
	"result_delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "task_delegations_status_valid" CHECK ("task_delegations"."status" in ('waiting', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "task_delegations_not_self" CHECK ("task_delegations"."parent_agent_id" <> "task_delegations"."target_agent_id")
);
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_status_valid";--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "purpose" text DEFAULT 'work' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "parent_task_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "depth" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_delegation_targets" ADD CONSTRAINT "agent_delegation_targets_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_delegation_targets" ADD CONSTRAINT "agent_delegation_targets_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_delegations" ADD CONSTRAINT "task_delegations_parent_task_id_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_delegations" ADD CONSTRAINT "task_delegations_parent_run_id_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_delegations" ADD CONSTRAINT "task_delegations_parent_agent_id_agents_id_fk" FOREIGN KEY ("parent_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_delegations" ADD CONSTRAINT "task_delegations_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_delegations" ADD CONSTRAINT "task_delegations_child_task_id_tasks_id_fk" FOREIGN KEY ("child_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_delegations_child_task_id_unique" ON "task_delegations" USING btree ("child_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_delegations_request_unique" ON "task_delegations" USING btree ("parent_task_id","request_hash");--> statement-breakpoint
CREATE INDEX "task_delegations_parent_task_id_idx" ON "task_delegations" USING btree ("parent_task_id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_parent_task_id_idx" ON "tasks" USING btree ("parent_task_id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_purpose_valid" CHECK ("runs"."purpose" in ('work', 'continue'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_depth_valid" CHECK ("tasks"."depth" >= 0 and ("tasks"."depth" = 0) = ("tasks"."parent_task_id" is null));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_status_valid" CHECK ("tasks"."status" in ('queued', 'running', 'awaiting_approval', 'waiting_on_delegate', 'completed', 'failed', 'cancelled', 'interrupted'));