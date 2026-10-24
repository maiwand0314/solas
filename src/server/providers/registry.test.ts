import { describe, expect, it } from "vitest";
import {
  checkModelSelection,
  createProviderRegistry,
  getAgentReadiness,
  providerRegistry,
} from "./registry";

const testRegistry = createProviderRegistry([
  { id: "ready", label: "Ready provider", status: "available", models: [{ id: "model-a", label: "A" }] },
  { id: "later", label: "Later provider", status: "unconfigured", statusReason: "Not built.", models: [] },
]);

describe("checkModelSelection", () => {
  it("treats no provider and no model as 'not configured', which is allowed", () => {
    expect(checkModelSelection(testRegistry, null, null)).toBeNull();
  });

  it("accepts a model offered by an available provider", () => {
    expect(checkModelSelection(testRegistry, "ready", "model-a")).toBeNull();
  });

  it.each([
    ["only a model", null, "model-a", "providerId"],
    ["only a provider", "ready", null, "modelId"],
    ["an unknown provider", "nope", "model-a", "providerId"],
    ["an unconfigured provider", "later", "model-a", "providerId"],
    ["an unknown model", "ready", "model-z", "modelId"],
  ] as const)("rejects %s", (_label, providerId, modelId, field) => {
    expect(checkModelSelection(testRegistry, providerId, modelId)?.field).toBe(field);
  });

  it("offers Claude in the real registry with full model IDs, not aliases", () => {
    const claude = providerRegistry.get("claude-agent-sdk");
    expect(claude?.status).toBe("available");
    expect(claude?.models.map((model) => model.id)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
  });
});

describe("getAgentReadiness", () => {
  it("reports disabled agents first", () => {
    expect(getAgentReadiness({ enabled: false, providerId: "ready", modelId: "model-a" }, testRegistry)).toEqual({
      state: "disabled",
    });
  });

  it("reports agents without a model as unconfigured", () => {
    expect(getAgentReadiness({ enabled: true, providerId: null, modelId: null }, testRegistry).state).toBe(
      "unconfigured",
    );
  });

  it("re-checks the registry, so a provider that becomes unavailable makes agents unconfigured", () => {
    expect(getAgentReadiness({ enabled: true, providerId: "later", modelId: "x" }, testRegistry).state).toBe(
      "unconfigured",
    );
    expect(getAgentReadiness({ enabled: true, providerId: "ready", modelId: "model-a" }, testRegistry)).toEqual({
      state: "ready",
    });
  });
});
