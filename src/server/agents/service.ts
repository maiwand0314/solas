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
import { AgentServiceError, fromDatabaseError, notFoundError, validationError } from "./errors";
import { agentIdSchema, createAgentSchema, enabledSchema, updateAgentSchema } from "./validation";

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

  function assertModelSelection(providerId: string | null, modelId: string | null) {
    const problem = checkModelSelection(providers, providerId, modelId);
    if (problem) {
      throw new AgentServiceError("validation_failed", problem.message, {
        [problem.field]: [problem.message],
      });
    }
  }

  return { list, get, create, update, remove, setEnabled };
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
