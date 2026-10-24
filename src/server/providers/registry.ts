// Execution providers this build of Solas knows about, kept separate from
// agent storage. An agent only stores { providerId, modelId }; whether that
// pair is usable is decided here, in code, at the time it's checked.

export type ProviderStatus = "available" | "unconfigured";

export type ModelDefinition = {
  id: string;
  label: string;
};

export type ProviderDefinition = {
  id: string;
  label: string;
  /** Only "available" providers can be selected for an agent. */
  status: ProviderStatus;
  /** Why the provider can't be used yet, shown to the owner. */
  statusReason?: string;
  models: readonly ModelDefinition[];
};

export type ProviderRegistry = {
  list(): readonly ProviderDefinition[];
  get(id: string): ProviderDefinition | undefined;
};

export function createProviderRegistry(providers: readonly ProviderDefinition[]): ProviderRegistry {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  return {
    list: () => providers,
    get: (id) => byId.get(id),
  };
}

/**
 * Nothing is "available" until Solas can actually run an agent through it.
 * The Claude Agent SDK provider is verified and enabled in M3; until then
 * every agent is honestly "not configured".
 */
export const providerRegistry = createProviderRegistry([
  {
    id: "claude-agent-sdk",
    label: "Claude (Claude Agent SDK)",
    status: "unconfigured",
    statusReason: "Agent execution isn’t built yet.",
    models: [],
  },
]);

/** Human-readable "Provider · Model", or null when the agent has no model. */
export function describeModelSelection(
  registry: ProviderRegistry,
  agent: { providerId: string | null; modelId: string | null },
): string | null {
  if (agent.providerId === null || agent.modelId === null) return null;
  const provider = registry.get(agent.providerId);
  const model = provider?.models.find((candidate) => candidate.id === agent.modelId);
  return `${provider?.label ?? agent.providerId} · ${model?.label ?? agent.modelId}`;
}

export type ModelSelectionProblem = {
  field: "providerId" | "modelId";
  message: string;
};

/**
 * Checks a provider/model pair against the registry. Both empty is valid and
 * means "not configured". Returns null when the selection is acceptable.
 */
export function checkModelSelection(
  registry: ProviderRegistry,
  providerId: string | null,
  modelId: string | null,
): ModelSelectionProblem | null {
  if (providerId === null && modelId === null) return null;
  if (providerId === null) return { field: "providerId", message: "Choose a provider for this model." };
  if (modelId === null) return { field: "modelId", message: "Choose a model for this provider." };

  const provider = registry.get(providerId);
  if (!provider) return { field: "providerId", message: `Unknown provider “${providerId}”.` };
  if (provider.status !== "available") {
    return {
      field: "providerId",
      message: `${provider.label} can’t be used yet. ${provider.statusReason ?? ""}`.trim(),
    };
  }
  if (!provider.models.some((model) => model.id === modelId)) {
    return { field: "modelId", message: `${provider.label} doesn’t offer the model “${modelId}”.` };
  }
  return null;
}

export type AgentReadiness =
  | { state: "ready" }
  | { state: "disabled" }
  | { state: "unconfigured"; reason: string };

/** Whether an agent could run right now. Computed, never stored. */
export function getAgentReadiness(
  agent: { enabled: boolean; providerId: string | null; modelId: string | null },
  registry: ProviderRegistry,
): AgentReadiness {
  if (!agent.enabled) return { state: "disabled" };
  if (agent.providerId === null || agent.modelId === null) {
    return { state: "unconfigured", reason: "No model selected." };
  }
  const problem = checkModelSelection(registry, agent.providerId, agent.modelId);
  return problem ? { state: "unconfigured", reason: problem.message } : { state: "ready" };
}
