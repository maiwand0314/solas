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
// Relative and type-only: drizzle-kit loads this file without the app's path aliases.
import type { Schedule } from "../../lib/automations/schedule";

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

/**
 * A team of agents (M5B): a named group the owner uses to organise agents
 * that work together. Membership and roles are in team_members. A team
 * grants nothing by itself: delegation still needs explicit targets.
 */
export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`now()`),
  },
  (table) => [
    uniqueIndex("teams_name_lower_unique").on(sql`lower(${table.name})`),
    check("teams_name_not_blank", sql`length(trim(${table.name})) > 0`),
  ],
);

export const TEAM_ROLES = ["coordinator", "member"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

/**
 * Which agents belong to which team, and in which role. One row per agent
 * per team (the primary key prevents duplicates). The coordinator is simply
 * the member whose role is "coordinator", so a coordinator is always a member,
 * and at most one per team (partial unique index). Deleting a team or an
 * agent removes its rows; the agents and tasks themselves stay.
 */
export const teamMembers = pgTable(
  "team_members",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    role: text("role", { enum: TEAM_ROLES }).notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.teamId, table.agentId] }),
    uniqueIndex("team_members_one_coordinator").on(table.teamId).where(sql`${table.role} = 'coordinator'`),
    index("team_members_agent_id_idx").on(table.agentId),
    check("team_members_role_valid", sql`${table.role} in ('coordinator', 'member')`),
  ],
);

/**
 * An automation (M6A): an agent, task instructions, and a schedule. When a
 * run is due, the worker's scheduler creates an ordinary task from it (see
 * automation_occurrences), so scheduled work goes through the same queue,
 * permissions, and approvals as any task. Deleting the agent deletes its
 * automations, like its tasks.
 */
export const automations = pgTable(
  "automations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** What the agent is asked to do each run: becomes the task's instructions. */
    instructions: text("instructions").notNull(),
    /** When it runs (see src/lib/automations/schedule.ts), validated in code like providers and tools. */
    schedule: jsonb("schedule").$type<Schedule>().notNull(),
    /** IANA time zone the schedule's times are in. */
    timeZone: text("time_zone").notNull().default("Europe/Oslo"),
    /** False while paused: nothing is scheduled. */
    enabled: boolean("enabled").notNull().default(true),
    /** When the schedule was last set; "every N hours" counts from here. */
    scheduleAnchorAt: timestamp("schedule_anchor_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * The next run, or null when nothing is scheduled (paused, or a one-time
     * run that has happened or was missed). The scheduler looks only at this.
     */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    /** The scheduled time of the last run that started a task. */
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`now()`),
  },
  (table) => [
    uniqueIndex("automations_name_lower_unique").on(sql`lower(${table.name})`),
    check("automations_name_not_blank", sql`length(trim(${table.name})) > 0`),
    check("automations_paused_has_no_next_run", sql`${table.enabled} or ${table.nextRunAt} is null`),
    // The scheduler asks "which active automations are due?"
    index("automations_due_idx").on(table.nextRunAt).where(sql`${table.enabled} and ${table.nextRunAt} is not null`),
    index("automations_agent_id_idx").on(table.agentId),
  ],
);

export const TASK_STATUSES = [
  "queued",
  "running",
  "awaiting_approval",
  "waiting_on_delegate",
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
    /**
     * Set on a task another agent delegated (M5A): the task it serves. Its
     * result goes back to that task. A function reference: tasks points at itself.
     */
    parentTaskId: uuid("parent_task_id").references((): AnyPgColumn => tasks.id, { onDelete: "cascade" }),
    /** 0 for a task the owner created, 1 for a delegated one. Delegation stops at a configured depth. */
    depth: integer("depth").notNull().default(0),
    /**
     * The team this task was given to (M5B), chosen when it's created (a
     * delegated task inherits its parent's). Fixed afterwards: later
     * membership changes don't move it. Deleting the team keeps the task.
     */
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "set null" }),
    /**
     * The automation that created this task (M6A), if any. Deleting the
     * automation keeps the task and its history.
     */
    automationId: uuid("automation_id").references(() => automations.id, { onDelete: "set null" }),
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
      sql`${table.status} in ('queued', 'running', 'awaiting_approval', 'waiting_on_delegate', 'completed', 'failed', 'cancelled', 'interrupted')`,
    ),
    check("tasks_title_not_blank", sql`length(trim(${table.title})) > 0`),
    check("tasks_depth_valid", sql`${table.depth} >= 0 and (${table.depth} = 0) = (${table.parentTaskId} is null)`),
    index("tasks_parent_task_id_idx").on(table.parentTaskId),
    index("tasks_team_id_idx").on(table.teamId),
    index("tasks_automation_id_idx").on(table.automationId),
    check("tasks_auto_retries_left_valid", sql`${table.autoRetriesLeft} between 0 and 5`),
    uniqueIndex("tasks_client_request_id_unique").on(table.clientRequestId),
    index("tasks_updated_at_idx").on(table.updatedAt),
    index("tasks_agent_id_idx").on(table.agentId),
  ],
);

export const OCCURRENCE_STATUSES = ["started", "missed", "skipped"] as const;
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];

/** Why a due run didn't start a task. */
export const OCCURRENCE_SKIP_REASONS = [
  "overlap",
  "agent_unavailable",
  "usage_limit",
  "concurrency_limit",
  "daily_limit",
] as const;
export type OccurrenceSkipReason = (typeof OCCURRENCE_SKIP_REASONS)[number];

/**
 * One run of an automation (M6A): its history, including runs that didn't
 * start. Its identity is (automation, scheduled time), enforced by a unique
 * index, so two schedulers handling the same due run can't both record it,
 * and only the one that does creates the task. Messages are written by Solas.
 */
export const automationOccurrences = pgTable(
  "automation_occurrences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    /** The run's scheduled time (for "Run now", the moment it was asked for). */
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    /** "schedule": from the schedule. "manual": the owner's Run now. */
    trigger: text("trigger", { enum: ["schedule", "manual"] }).notNull().default("schedule"),
    /** "started": a task was created. "missed": too late to start. "skipped": a safeguard stopped it. */
    status: text("status", { enum: OCCURRENCE_STATUSES }).notNull(),
    reason: text("reason", { enum: OCCURRENCE_SKIP_REASONS }),
    /** For "missed": how many runs this row stands for (one row per period of downtime). */
    missedCount: integer("missed_count").notNull().default(0),
    message: text("message").notNull(),
    /** The task it created. Kept as history if the task is deleted with its agent. */
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("automation_occurrences_once_per_time").on(table.automationId, table.scheduledFor),
    index("automation_occurrences_automation_idx").on(table.automationId, table.createdAt),
    uniqueIndex("automation_occurrences_task_id_unique").on(table.taskId),
    check("automation_occurrences_status_valid", sql`${table.status} in ('started', 'missed', 'skipped')`),
    check("automation_occurrences_trigger_valid", sql`${table.trigger} in ('schedule', 'manual')`),
    check(
      "automation_occurrences_reason_matches",
      sql`(${table.status} = 'skipped') = (${table.reason} is not null)`,
    ),
    check(
      "automation_occurrences_reason_valid",
      sql`${table.reason} is null or ${table.reason} in ('overlap', 'agent_unavailable', 'usage_limit', 'concurrency_limit', 'daily_limit')`,
    ),
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
    /**
     * "work": a normal run. "continue" (M5A): a task's follow-up run after its
     * delegated task finished, given that result instead of the delegation tool.
     */
    purpose: text("purpose", { enum: ["work", "continue"] }).notNull().default("work"),
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
    check("runs_purpose_valid", sql`${table.purpose} in ('work', 'continue')`),
  ],
);

/**
 * Which agents an agent may delegate tasks to (M5A). Like tool permissions:
 * a row exists only for an allowed target, so delegation is off until the
 * owner chooses targets. Deleting either agent removes the row.
 */
export const agentDelegationTargets = pgTable(
  "agent_delegation_targets",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    targetAgentId: uuid("target_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.targetAgentId] }),
    check("agent_delegation_targets_not_self", sql`${table.agentId} <> ${table.targetAgentId}`),
  ],
);

export const DELEGATION_STATUSES = ["waiting", "completed", "failed", "cancelled"] as const;
export type DelegationStatus = (typeof DELEGATION_STATUSES)[number];

/**
 * One delegation (M5A): a parent task's agent asked another agent to do a
 * subtask, which became a child task. Records the request (exactly what was
 * sent), its status, and whether the result reached the parent. The child's
 * result itself stays on the child task.
 */
export const taskDelegations = pgTable(
  "task_delegations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    parentTaskId: uuid("parent_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    /** The parent's run that asked for it. */
    parentRunId: uuid("parent_run_id").references(() => runs.id, { onDelete: "set null" }),
    parentAgentId: uuid("parent_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    targetAgentId: uuid("target_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    childTaskId: uuid("child_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    /** Exactly what the parent sent: the only information the child gets. */
    taskDescription: text("task_description").notNull(),
    expectedOutput: text("expected_output"),
    /** Identifies a repeated request (same target and words), so a retry reuses the child. */
    requestHash: text("request_hash").notNull(),
    /** "waiting" until the child task completes, fails, or is cancelled. */
    status: text("status", { enum: DELEGATION_STATUSES }).notNull().default("waiting"),
    /** What the parent wrote before it delegated, given back to it with the result. */
    parentNotes: text("parent_notes"),
    /** When the result (or failure) was handed to the parent agent. */
    resultDeliveredAt: timestamp("result_delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("task_delegations_child_task_id_unique").on(table.childTaskId),
    uniqueIndex("task_delegations_request_unique").on(table.parentTaskId, table.requestHash),
    index("task_delegations_parent_task_id_idx").on(table.parentTaskId),
    check("task_delegations_status_valid", sql`${table.status} in ('waiting', 'completed', 'failed', 'cancelled')`),
    check("task_delegations_not_self", sql`${table.parentAgentId} <> ${table.targetAgentId}`),
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
  "delegated",
  "waiting_on_delegate",
  "delegate_finished",
  "continuation_queued",
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
  /** Delegation (M5A): the other task involved. */
  childTaskId?: string;
  parentTaskId?: string;
  delegationId?: string;
  /** Automations (M6A): the automation and the run that created the task. */
  automationId?: string;
  occurrenceId?: string;
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
export type TaskDelegationRow = typeof taskDelegations.$inferSelect;
export type TeamRow = typeof teams.$inferSelect;
export type TeamMemberRow = typeof teamMembers.$inferSelect;
export type AutomationRow = typeof automations.$inferSelect;
export type AutomationOccurrenceRow = typeof automationOccurrences.$inferSelect;
