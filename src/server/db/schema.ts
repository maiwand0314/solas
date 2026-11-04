import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

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

/**
 * A chat thread between the owner and one agent. Deleting the agent deletes
 * its conversations: a conversation can't outlive the agent that answers it.
 */
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`now()`),
  },
  (table) => [index("conversations_agent_id_idx").on(table.agentId)],
);

/**
 * One message in a conversation. History is append-only: messages are never
 * edited. An assistant message points at the run that produced it.
 */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    // A function reference because runs is declared below (and points back here).
    runId: uuid("run_id").references((): AnyPgColumn => runs.id, { onDelete: "set null" }),
    /**
     * Chosen by the browser for each message it sends, and sent again if it
     * retries. The unique index turns a repeated send into "already saved"
     * instead of a duplicate message.
     */
    clientMessageId: uuid("client_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("messages_conversation_id_created_at_idx").on(table.conversationId, table.createdAt),
    uniqueIndex("messages_client_message_id_unique").on(table.clientMessageId),
    // One run produces at most one saved reply, whatever happens in the worker.
    uniqueIndex("messages_one_reply_per_run")
      .on(table.runId)
      .where(sql`${table.role} = 'assistant'`),
    check("messages_role_valid", sql`${table.role} in ('user', 'assistant')`),
  ],
);

export const RUN_STATUSES = ["pending", "running", "completed", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TASK_STATUSES = [
  "queued",
  "running",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * A piece of work the owner hands to an agent: "do this, I'll check back".
 * The task is the request and its outcome; each attempt at it is a run (see
 * runs.task_id), so tasks use the same queue, worker, and runtime as
 * conversations. The status is kept here, changed only through the
 * transitions in src/server/tasks/lifecycle.ts.
 */
export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Deleting an agent deletes its tasks, like its conversations.
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    instructions: text("instructions").notNull(),
    status: text("status", { enum: TASK_STATUSES }).notNull().default("queued"),
    /** The agent's final answer, saved when an attempt completes. */
    result: text("result"),
    /** Stable code and owner-safe message; set when the task failed or was interrupted. */
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    /** Set by the owner's Cancel while an attempt runs; the worker stops it and confirms. */
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    /**
     * Automatic retries still allowed after a lost worker or a provider
     * outage. Bounded so nothing loops; a manual retry resets it.
     */
    autoRetriesLeft: integer("auto_retries_left").notNull().default(1),
    /**
     * Chosen by the browser for each submit, and sent again if it retries.
     * The unique index turns a repeated submit into "already created".
     */
    clientRequestId: uuid("client_request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`now()`),
    /** When the first attempt started. */
    startedAt: timestamp("started_at", { withTimezone: true }),
    /** When the task reached completed, failed, cancelled, or interrupted. */
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "tasks_status_valid",
      sql`${table.status} in ('queued', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'interrupted')`,
    ),
    check("tasks_title_not_blank", sql`length(trim(${table.title})) > 0`),
    check("tasks_auto_retries_left_valid", sql`${table.autoRetriesLeft} between 0 and 5`),
    uniqueIndex("tasks_client_request_id_unique").on(table.clientRequestId),
    index("tasks_updated_at_idx").on(table.updatedAt),
    index("tasks_agent_id_idx").on(table.agentId),
  ],
);

/**
 * One execution of an agent: "answer this user message" or "work on this
 * task". The web app inserts it as pending; the worker claims it, runs it,
 * and records the outcome. The table doubles as the job queue, so there's no
 * separate queue service. A run belongs to exactly one of a conversation or
 * a task.
 */
export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Set for a conversation run (with userMessageId); null for a task run. */
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    userMessageId: uuid("user_message_id").references((): AnyPgColumn => messages.id, { onDelete: "cascade" }),
    /** Set for a task run: this run is one attempt at that task. */
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    /** Which attempt at the task this is, from 1. Always 1 for conversation runs. */
    attempt: integer("attempt").notNull().default(1),
    /** The worker that claimed it: whose heartbeat keeps it alive. */
    workerId: text("worker_id"),
    /** A scheduled retry isn't claimed before this time (backoff). */
    notBefore: timestamp("not_before", { withTimezone: true }),
    status: text("status", { enum: RUN_STATUSES }).notNull().default("pending"),
    /** The model actually requested, recorded when the run starts. */
    modelId: text("model_id"),
    /** Stable code and owner-safe message; set when status is failed. */
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    /** Set by the owner's Stop button; the worker notices and aborts. */
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    /**
     * The reply as Claude writes it, updated while the run is running so the
     * owner can read along. The finished reply is saved as a message; this
     * keeps what was written before a stop or failure.
     */
    partialOutput: text("partial_output"),
    /** Refreshed every second by the worker running it; a stale value means that worker is gone. */
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    check("runs_status_valid", sql`${table.status} in ('pending', 'running', 'completed', 'failed', 'cancelled')`),
    // At most one unfinished run per conversation. This is what stops a double
    // click (or two tabs) from asking the agent the same thing twice.
    uniqueIndex("runs_one_active_per_conversation")
      .on(table.conversationId)
      .where(sql`${table.status} in ('pending', 'running')`),
    // The same for tasks: one attempt at a time, so a task never runs twice at once.
    uniqueIndex("runs_one_active_per_task")
      .on(table.taskId)
      .where(sql`${table.status} in ('pending', 'running')`),
    check(
      "runs_belong_to_conversation_or_task",
      sql`(${table.taskId} is null and ${table.conversationId} is not null and ${table.userMessageId} is not null)
        or (${table.taskId} is not null and ${table.conversationId} is null and ${table.userMessageId} is null)`,
    ),
    // The worker looks for the oldest pending run.
    index("runs_status_created_at_idx").on(table.status, table.createdAt),
    index("runs_task_id_idx").on(table.taskId),
  ],
);

export const TASK_EVENT_TYPES = [
  "created",
  "queued",
  "claimed",
  "started",
  "tool_requested",
  "tool_denied",
  "approval_requested",
  "approval_granted",
  "approval_rejected",
  "approval_expired",
  "approval_cancelled",
  "tool_succeeded",
  "tool_failed",
  "completed",
  "failed",
  "cancel_requested",
  "cancelled",
  "interrupted",
  "retry_scheduled",
] as const;
export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];

/**
 * What happened to a task, in order: the timeline on the task's page and its
 * audit trail. Append-only. Messages are written by Solas, never copied from
 * the model or a provider, and data holds only IDs and codes: no tool
 * output, no credentials.
 */
export const taskEvents = pgTable(
  "task_events",
  {
    // Sequential, so "events after N" is exact even within one millisecond.
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    type: text("type", { enum: TASK_EVENT_TYPES }).notNull(),
    message: text("message").notNull(),
    data: jsonb("data").$type<TaskEventData>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("task_events_task_id_idx").on(table.taskId, table.id)],
);

/** The only fields an event may carry: references and codes, nothing sensitive. */
export type TaskEventData = {
  attempt?: number;
  toolId?: string;
  toolCallId?: string;
  code?: string;
  /** For a scheduled retry: when it may start (ISO). */
  notBefore?: string;
};

/**
 * Which tools an agent may use, and how. A row exists only for an enabled
 * tool: no row means the tool is off, so every agent starts with none.
 * Tool IDs are checked against the tool registry in code (like providers),
 * so adding a tool never needs a migration.
 */
export const agentToolPermissions = pgTable(
  "agent_tool_permissions",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    toolId: text("tool_id").notNull(),
    /** "allow": runs when the agent asks. "ask": waits for the owner's approval each time. */
    mode: text("mode", { enum: ["allow", "ask"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.toolId] }),
    check("agent_tool_permissions_mode_valid", sql`${table.mode} in ('allow', 'ask')`),
  ],
);

export const TOOL_CALL_STATUSES = [
  "awaiting_approval",
  "approved",
  "rejected",
  "expired",
  "running",
  "succeeded",
  "failed",
  "denied",
  "cancelled",
] as const;
export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number];

/**
 * Every tool call an agent makes, including refused ones: the activity log
 * the conversation shows, and the approval record. Inputs are the validated
 * arguments the tool ran with (never credentials; tools don't take any).
 */
export const toolCalls = pgTable(
  "tool_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    toolId: text("tool_id").notNull(),
    input: jsonb("input").notNull(),
    /** A short, readable version of the input, e.g. "notes/plan.md". */
    inputSummary: text("input_summary").notNull(),
    status: text("status", { enum: TOOL_CALL_STATUSES }).notNull(),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    approvalExpiresAt: timestamp("approval_expires_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    resultSummary: text("result_summary"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("tool_calls_run_id_idx").on(table.runId, table.createdAt),
    check(
      "tool_calls_status_valid",
      sql`${table.status} in ('awaiting_approval', 'approved', 'rejected', 'expired', 'running', 'succeeded', 'failed', 'denied', 'cancelled')`,
    ),
  ],
);

export type AgentToolPermissionRow = typeof agentToolPermissions.$inferSelect;
export type ToolCallRow = typeof toolCalls.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type TaskEventRow = typeof taskEvents.$inferSelect;
