import "server-only";
import { eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { getDatabase, type Database } from "@/server/db/client";
import { agents, type AgentRow } from "@/server/db/schema";
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
} from "@/lib/agents/validation";
import { AgentServiceError, fromDatabaseError, notFoundError, validationError } from "./errors";

export type Agent = AgentRow;

type Dependencies = {
  db: Database;
  providers: ProviderRegistry;
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
export function createAgentService({ db, providers }: Dependencies) {
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
    const values = parse(createAgentSchema, input);
    assertModelSelection(values.providerId, values.modelId);
    const [agent] = await query(() => db.insert(agents).values(values).returning());
    return agent;
  }

  async function update(id: unknown, input: unknown): Promise<Agent> {
    const agentId = parse(agentIdSchema, id);
    const changes = parse(updateAgentSchema, input);

    // The provider/model rule applies to the row as it will be after the
    // update, so fill in whichever half isn't changing from the current row.
    if (changes.providerId !== undefined || changes.modelId !== undefined) {
      const current = await get(agentId);
      assertModelSelection(
        changes.providerId !== undefined ? changes.providerId : current.providerId,
        changes.modelId !== undefined ? changes.modelId : current.modelId,
      );
    }

    const [agent] = await query(() =>
      db.update(agents).set(changes).where(eq(agents.id, agentId)).returning(),
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

  function assertModelSelection(providerId: string | null, modelId: string | null) {
    const problem = checkModelSelection(providers, providerId, modelId);
    if (problem) {
      throw new AgentServiceError("validation_failed", problem.message, {
        [problem.field]: [problem.message],
      });
    }
  }

  return { list, get, create, update, remove, setEnabled, duplicate };
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
