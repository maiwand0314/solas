"use server";

// Server Actions for agents: what the Agent Builder UI calls to change data.
// Each action checks the owner first, then delegates to the agent service,
// and returns an ActionResult instead of throwing so forms can show errors.
// Reads don't need actions: Server Components use src/server/agents/queries.ts.

import { revalidatePath } from "next/cache";
import { toActionError, type ActionResult } from "@/server/actions/result";
import { getAgentService, type Agent } from "@/server/agents/service";
import { requireOwner } from "@/server/auth/owner";

type RefreshScope = "all-agent-pages" | "agent-list";

async function mutate<T>(change: () => Promise<T>, refresh: RefreshScope): Promise<ActionResult<T>> {
  try {
    await requireOwner();
    const data = await change();
    if (refresh === "all-agent-pages") {
      // The list and every /agents/... page below it.
      revalidatePath("/agents", "layout");
    } else {
      revalidatePath("/agents");
    }
    return { ok: true, data };
  } catch (error) {
    return toActionError(error);
  }
}

export async function createAgent(input: unknown): Promise<ActionResult<Agent>> {
  return mutate(() => getAgentService().create(input), "all-agent-pages");
}

export async function updateAgent(id: unknown, input: unknown): Promise<ActionResult<Agent>> {
  return mutate(() => getAgentService().update(id, input), "all-agent-pages");
}

export async function setAgentEnabled(id: unknown, enabled: unknown): Promise<ActionResult<Agent>> {
  return mutate(() => getAgentService().setEnabled(id, enabled), "all-agent-pages");
}

export async function duplicateAgent(id: unknown): Promise<ActionResult<Agent>> {
  return mutate(() => getAgentService().duplicate(id), "all-agent-pages");
}

export async function deleteAgent(id: unknown): Promise<ActionResult<null>> {
  // Refresh only the list: re-rendering the deleted agent's own page would
  // briefly show "not found" before the browser moves on to /agents.
  return mutate(async () => {
    await getAgentService().remove(id);
    return null;
  }, "agent-list");
}
