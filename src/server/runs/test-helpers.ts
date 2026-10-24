import { agents } from "@/server/db/schema";
import type { Database } from "@/server/db/client";
import { createProviderRegistry } from "@/server/providers/registry";
import type { AgentRuntime, OnProgress, RunInput, RunResult } from "@/server/runtime/types";

// Shared by the conversation and executor tests: a fixed provider registry and
// a fake runtime, so tests never depend on (or call) the real Claude.

export const testProviders = createProviderRegistry([
  { id: "fake", label: "Fake", status: "available", models: [{ id: "fake-model", label: "Fake model" }] },
]);

export async function insertAgent(db: Database, overrides: Partial<typeof agents.$inferInsert> = {}) {
  const [agent] = await db
    .insert(agents)
    .values({
      name: "Research Assistant",
      role: "research",
      instructions: "Research topics and write clear reports.",
      providerId: "fake",
      modelId: "fake-model",
      ...overrides,
    })
    .returning();
  return agent;
}

/**
 * A runtime whose behavior each test sets. It records every input, so tests
 * can check exactly what the agent was asked and with which instructions.
 */
export function fakeRuntime(
  behave: (input: RunInput, signal: AbortSignal, onProgress?: OnProgress) => Promise<RunResult>,
) {
  const inputs: RunInput[] = [];
  const runtime: AgentRuntime = {
    providerId: "fake",
    run: (input, signal, onProgress) => {
      inputs.push(input);
      return behave(input, signal, onProgress);
    },
  };
  return { runtime, inputs };
}

/** Resolves only when the signal aborts, like a provider that never answers. */
export function untilAborted(signal: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve({ status: "aborted" }), { once: true });
  });
}
