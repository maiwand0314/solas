import { sql } from "drizzle-orm";
import { boolean, check, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// The database schema, written in TypeScript. drizzle-kit compares this file
// with the migrations in /drizzle and generates SQL for the difference.

/**
 * An agent is data, not code: everything that makes one agent different from
 * another lives in its row. Future features (tool permissions, workspaces,
 * conversations, execution settings) get their own tables that reference
 * agents.id, so this table stays small and focused.
 */
export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    role: text("role").notNull().default(""),
    /** The agent's system instructions. */
    instructions: text("instructions").notNull().default(""),
    // Which execution provider and model the agent should use. Stored as plain
    // text and validated against the provider registry in code, so adding a
    // provider never needs a migration. Both NULL means "not configured yet".
    providerId: text("provider_id"),
    modelId: text("model_id"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Set by the database clock on every update, like createdAt on insert,
    // so both timestamps come from the same clock.
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`now()`),
  },
  (table) => [
    // Names are how the owner tells agents apart, so they are unique
    // regardless of letter case ("Researcher" and "researcher" collide).
    uniqueIndex("agents_name_lower_unique").on(sql`lower(${table.name})`),
    // The app validates these too; the database is the last line of defense.
    check("agents_name_not_blank", sql`length(trim(${table.name})) > 0`),
    check(
      "agents_provider_and_model_together",
      sql`(${table.providerId} is null) = (${table.modelId} is null)`,
    ),
  ],
);

export type AgentRow = typeof agents.$inferSelect;
