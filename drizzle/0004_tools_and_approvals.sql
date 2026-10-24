CREATE TABLE "agent_tool_permissions" (
	"agent_id" uuid NOT NULL,
	"tool_id" text NOT NULL,
	"mode" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_tool_permissions_agent_id_tool_id_pk" PRIMARY KEY("agent_id","tool_id"),
	CONSTRAINT "agent_tool_permissions_mode_valid" CHECK ("agent_tool_permissions"."mode" in ('allow', 'ask'))
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"tool_id" text NOT NULL,
	"input" jsonb NOT NULL,
	"input_summary" text NOT NULL,
	"status" text NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"approval_expires_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"result_summary" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "tool_calls_status_valid" CHECK ("tool_calls"."status" in ('awaiting_approval', 'approved', 'rejected', 'expired', 'running', 'succeeded', 'failed', 'denied', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "agent_tool_permissions" ADD CONSTRAINT "agent_tool_permissions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_calls_run_id_idx" ON "tool_calls" USING btree ("run_id","created_at");