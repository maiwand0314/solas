import { describe, expect, it } from "vitest";
import { agentIdSchema, createAgentSchema, updateAgentSchema } from "./validation";

describe("createAgentSchema", () => {
  it("accepts a name only and fills in defaults", () => {
    expect(createAgentSchema.parse({ name: "Researcher" })).toEqual({
      name: "Researcher",
      description: "",
      role: "",
      instructions: "",
      providerId: null,
      modelId: null,
      enabled: true,
    });
  });

  it("trims whitespace", () => {
    expect(createAgentSchema.parse({ name: "  Writer  ", role: " Editor " })).toMatchObject({
      name: "Writer",
      role: "Editor",
    });
  });

  it.each([
    ["missing name", {}],
    ["blank name", { name: "   " }],
    ["name too long", { name: "x".repeat(81) }],
    ["wrong type", { name: 42 }],
    ["instructions too long", { name: "A", instructions: "x".repeat(20_001) }],
    ["empty provider string", { name: "A", providerId: "" }],
    ["enabled not boolean", { name: "A", enabled: "yes" }],
  ])("rejects %s", (_label, input) => {
    expect(createAgentSchema.safeParse(input).success).toBe(false);
  });

  it("rejects fields that aren't part of the agent (no mass assignment)", () => {
    const result = createAgentSchema.safeParse({ name: "A", id: "x", createdAt: new Date() });
    expect(result.success).toBe(false);
  });
});

describe("updateAgentSchema", () => {
  it("accepts a partial change", () => {
    expect(updateAgentSchema.parse({ role: "Planner" })).toEqual({ role: "Planner" });
  });

  it("rejects an empty change", () => {
    expect(updateAgentSchema.safeParse({}).success).toBe(false);
  });

  it("allows clearing the model with null", () => {
    expect(updateAgentSchema.parse({ providerId: null, modelId: null })).toEqual({
      providerId: null,
      modelId: null,
    });
  });
});

describe("agentIdSchema", () => {
  it("accepts a UUID and rejects anything else", () => {
    expect(agentIdSchema.safeParse("0b9a3c7e-4f7d-4c1e-9a55-2f0f6d8c2b11").success).toBe(true);
    expect(agentIdSchema.safeParse("1").success).toBe(false);
    expect(agentIdSchema.safeParse("1; drop table agents").success).toBe(false);
  });
});
