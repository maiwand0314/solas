"use server";

// Server Actions for agents: the entry point the Agent Builder UI (M2B) will
// call. Each action checks the owner first, then delegates to the agent
// service. Next.js only exposes actions that some page or component imports,
// so none of these are reachable over HTTP until the UI uses them.
// Reads don't need actions: Server Components call the service directly.

import { revalidatePath } from "next/cache";
import { toActionError, type ActionResult } from "@/server/actions/result";
import { getAgentService, type Agent } from "@/server/agents/service";
import { requireOwner } from "@/server/auth/owner";

async function mutate<T>(change: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    await requireOwner();
    const data = await change();
    revalidatePath("/agents");
    return { ok: true, data };
  } catch (error) {
    return toActionError(error);
  }
}

export async function createAgent(input: unknown): Promise<ActionResult<Agent>> {
  return mutate(() => getAgentService().create(input));
}

export async function updateAgent(id: unknown, input: unknown): Promise<ActionResult<Agent>> {
  return mutate(() => getAgentService().update(id, input));
}

export async function setAgentEnabled(id: unknown, enabled: unknown): Promise<ActionResult<Agent>> {
  return mutate(() => getAgentService().setEnabled(id, enabled));
}

export async function deleteAgent(id: unknown): Promise<ActionResult<null>> {
  return mutate(async () => {
    await getAgentService().remove(id);
    return null;
  });
}
