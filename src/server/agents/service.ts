import "server-only";
import { asc, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import { getDatabase, type Database } from "@/server/db/client";
import { agentDelegationTargets, agents, agentToolPermissions, type AgentRow } from "@/server/db/schema";
import { isPermissionTool, toolRegistry, type ToolRegistry } from "@/server/tools/registry";
import {
  checkModelSelection,
  providerRegistry,
  type ProviderRegistry,
} from "@/server/providers/registry";
import {
  AGENT_LIMITS,
  agentIdSchema,
  createAgentSchema,
  enabledSchema,
  updateAgentSchema,
  type AgentToolSetting,
} from "@/lib/agents/validation";
import { AgentServiceError, fromDatabaseError, notFoundError, validationError } from "./errors";

export type Agent = AgentRow;

/** An agent this agent may delegate to, as Agent Builder and the agent page show it. */
export type DelegationTarget = Pick<AgentRow, "id" | "name" | "role" | "enabled">;

type Dependencies = {
  db: Database;
  providers: ProviderRegistry;
  /** Which tools exist. Defaults to the app's registry. */
  tools?: ToolRegistry;
};

/**
 * All agent reads and writes go through this service. It validates input,
 * enforces provider rules, and converts database failures into
 * AgentServiceError. It knows nothing about HTTP, React, or who is calling,
 * so the web app, tests, CLI scripts, and (later) the worker can share it.
 * Authorization happens in the caller (see src/server/auth/owner.ts).
 *
 * Inputs are typed `unknown` on purpose: the service never trusts its caller.
 */
export function createAgentService({ db, providers, tools = toolRegistry }: Dependencies) {
  async function list(): Promise<Agent[]> {
    return query(() => db.select().from(agents).orderBy(sql`lower(${agents.name})`, agents.createdAt));
  }

  async function get(id: unknown): Promise<Agent> {
    const agentId = parse(agentIdSchema, id);
    const [agent] = await query(() => db.select().from(agents).where(eq(agents.id, agentId)).limit(1));
    if (!agent) throw notFoundError();
    return agent;
  }

  async function create(input: unknown): Promise<Agent> {
    const { tools: toolSettings, delegateTo, ...values } = parse(createAgentSchema, input);
    assertModelSelection(values.providerId, values.modelId);
    assertToolSettings(toolSettings);
    await assertDelegationTargets(null, delegateTo);
    return query(() =>
      db.transaction(async (tx) => {
        const [agent] = await tx.insert(agents).values(values).returning();
        if (toolSettings.length > 0) {
          await tx.insert(agentToolPermissions).values(toolSettings.map((tool) => ({ agentId: agent.id, ...tool })));
        }
        if (delegateTo.length > 0) {
          await tx
            .insert(agentDelegationTargets)
            .values(delegateTo.map((targetAgentId) => ({ agentId: agent.id, targetAgentId })));
        }
        return agent;
      }),
    );
  }

  /** The agents this agent may delegate to, by name. Empty: delegation is off. */
  async function getDelegationTargets(id: unknown): Promise<DelegationTarget[]> {
    const agentId = parse(agentIdSchema, id);
    return query(() =>
      db
        .select({ id: agents.id, name: agents.name, role: agents.role, enabled: agents.enabled })
        .from(agentDelegationTargets)
        .innerJoin(agents, eq(agents.id, agentDelegationTargets.targetAgentId))
        .where(eq(agentDelegationTargets.agentId, agentId))
        .orderBy(asc(sql`lower(${agents.name})`)),
    );
  }

  /** The agent's enabled tools, in registry order. Tools no longer in the registry are left out. */
  async function getTools(id: unknown): Promise<AgentToolSetting[]> {
    const agentId = parse(agentIdSchema, id);
    const rows = await query(() =>
      db
        .select({ toolId: agentToolPermissions.toolId, mode: agentToolPermissions.mode })
        .from(agentToolPermissions)
        .where(eq(agentToolPermissions.agentId, agentId)),
    );
    const order = tools.list().map((tool) => tool.id);
    return rows
      .filter((row) => tools.get(row.toolId))
      .sort((a, b) => order.indexOf(a.toolId) - order.indexOf(b.toolId));
  }

  async function update(id: unknown, input: unknown): Promise<Agent> {
    const agentId = parse(agentIdSchema, id);
    const { tools: toolSettings, delegateTo, ...changes } = parse(updateAgentSchema, input);
    if (toolSettings) assertToolSettings(toolSettings);
    if (delegateTo) await assertDelegationTargets(agentId, delegateTo);

    // The provider/model rule applies to the row as it will be after the
    // update, so fill in whichever half isn't changing from the current row.
    if (changes.providerId !== undefined || changes.modelId !== undefined) {
      const current = await get(agentId);
      assertModelSelection(
        changes.providerId !== undefined ? changes.providerId : current.providerId,
        changes.modelId !== undefined ? changes.modelId : current.modelId,
      );
    }

    // One transaction: the agent and its tool permissions change together.
    // A permission change applies to the next run (the worker reads them per run).
    const [agent] = await query(() =>
      db.transaction(async (tx) => {
        // Setting updatedAt also marks a tools-only change as an update.
        const updated = await tx
          .update(agents)
          .set({ ...changes, updatedAt: sql`now()` })
          .where(eq(agents.id, agentId))
          .returning();
        if (updated.length > 0 && toolSettings) {
          await tx.delete(agentToolPermissions).where(eq(agentToolPermissions.agentId, agentId));
          if (toolSettings.length > 0) {
            await tx.insert(agentToolPermissions).values(toolSettings.map((tool) => ({ agentId, ...tool })));
          }
        }
        // Like tools: applies from the next run on (the worker reads targets per run and per call).
        if (updated.length > 0 && delegateTo) {
          await tx.delete(agentDelegationTargets).where(eq(agentDelegationTargets.agentId, agentId));
          if (delegateTo.length > 0) {
            await tx.insert(agentDelegationTargets).values(delegateTo.map((targetAgentId) => ({ agentId, targetAgentId })));
          }
        }
        return updated;
      }),
    );
    if (!agent) throw notFoundError();
    return agent;
  }

  async function remove(id: unknown): Promise<void> {
    const agentId = parse(agentIdSchema, id);
    const deleted = await query(() =>
      db.delete(agents).where(eq(agents.id, agentId)).returning({ id: agents.id }),
    );
    if (deleted.length === 0) throw notFoundError();
  }

  async function setEnabled(id: unknown, enabled: unknown): Promise<Agent> {
    return update(id, { enabled: parse(enabledSchema, enabled) });
  }

  /**
   * Creates a new agent from an existing one's configuration, through the
   * normal create path (so all validation applies). Only configuration is
   * copied: never ids, timestamps, or (later) history or runtime state.
   * The copy starts disabled so it can be reviewed before it's used.
   */
  async function duplicate(id: unknown): Promise<Agent> {
    const source = await get(id);
    const sourceTools = await getTools(source.id);
    const sourceTargets = await getDelegationTargets(source.id);
    // Keep the model only while it's still selectable; otherwise start unconfigured.
    const keepModel = checkModelSelection(providers, source.providerId, source.modelId) === null;

    for (let attempt = 1; attempt <= MAX_COPY_ATTEMPTS; attempt++) {
      try {
        return await create({
          name: copyName(source.name, attempt),
          role: source.role,
          description: source.description,
          instructions: source.instructions,
          providerId: keepModel ? source.providerId : null,
          modelId: keepModel ? source.modelId : null,
          enabled: false,
          tools: sourceTools,
          delegateTo: sourceTargets.map((target) => target.id),
        });
      } catch (error) {
        if (error instanceof AgentServiceError && error.code === "name_taken") continue;
        if (error instanceof AgentServiceError && error.code === "validation_failed") {
          throw new AgentServiceError(
            "validation_failed",
            "This agent is missing required details. Edit it, then duplicate it again.",
            error.fieldErrors,
          );
        }
        throw error;
      }
    }
    throw new AgentServiceError(
      "name_taken",
      "There are already many copies of this agent. Rename some of them and try again.",
    );
  }

  /** Every tool must exist, and a tool that requires approval can't run automatically. */
  function assertToolSettings(settings: AgentToolSetting[]) {
    for (const setting of settings) {
      const tool = tools.get(setting.toolId);
      // Delegation is granted through delegation targets, never as a tool switch.
      const message = !tool || !isPermissionTool(tool)
        ? `Unknown tool “${setting.toolId}”.`
        : tool.approval === "required" && setting.mode !== "ask"
          ? `${tool.name} always needs your approval.`
          : null;
      if (message) throw new AgentServiceError("validation_failed", message, { tools: [message] });
    }
  }

  /** Every target must be an existing agent, and never the agent itself. */
  async function assertDelegationTargets(agentId: string | null, targetIds: string[]) {
    const fail = (message: string) => {
      throw new AgentServiceError("validation_failed", message, { delegateTo: [message] });
    };
    if (agentId && targetIds.includes(agentId)) fail("An agent can’t delegate to itself.");
    if (targetIds.length === 0) return;
    const found = await query(() => db.select({ id: agents.id }).from(agents).where(inArray(agents.id, targetIds)));
    if (found.length !== targetIds.length) fail("One of the chosen agents no longer exists. Reload and choose again.");
  }

  function assertModelSelection(providerId: string | null, modelId: string | null) {
    const problem = checkModelSelection(providers, providerId, modelId);
    if (problem) {
      throw new AgentServiceError("validation_failed", problem.message, {
        [problem.field]: [problem.message],
      });
    }
  }

  return { list, get, getTools, getDelegationTargets, create, update, remove, setEnabled, duplicate };
}

const MAX_COPY_ATTEMPTS = 20;

/** "Name (copy)", then "Name (copy 2)", … — shortened to fit the name limit. */
export function copyName(name: string, attempt: number): string {
  const suffix = attempt === 1 ? " (copy)" : ` (copy ${attempt})`;
  return name.slice(0, AGENT_LIMITS.name - suffix.length).trimEnd() + suffix;
}

export type AgentService = ReturnType<typeof createAgentService>;

/** The service wired to the app's database and provider registry. */
export function getAgentService(): AgentService {
  return createAgentService({ db: getDatabase(), providers: providerRegistry });
}

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw validationError(result.error);
  return result.data;
}

async function query<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw fromDatabaseError(error);
  }
}
