CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"role" text DEFAULT '' NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"provider_id" text,
	"model_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_name_not_blank" CHECK (length(trim("agents"."name")) > 0),
	CONSTRAINT "agents_provider_and_model_together" CHECK (("agents"."provider_id" is null) = ("agents"."model_id" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agents_name_lower_unique" ON "agents" USING btree (lower("name"));