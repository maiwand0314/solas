import { describe, expect, it } from "vitest";
import {
  agentIdSchema,
  createAgentSchema,
  updateAgentSchema,
  validateAgentInput,
} from "./validation";

const minimal = { name: "Researcher", role: "research", instructions: "Research topics." };

describe("createAgentSchema", () => {
  it("accepts name, role, and instructions, and fills in defaults", () => {
    expect(createAgentSchema.parse(minimal)).toEqual({
      ...minimal,
      description: "",
      providerId: null,
      modelId: null,
      enabled: true,
      tools: [], // every agent starts with no tools
      delegateTo: [], // and can't delegate
    });
  });

  it("trims whitespace", () => {
    expect(createAgentSchema.parse({ ...minimal, name: "  Writer  ", role: " Editor " })).toMatchObject({
      name: "Writer",
      role: "Editor",
    });
  });

  it.each([
    ["missing name", { role: "r", instructions: "i" }],
    ["blank name", { ...minimal, name: "   " }],
    ["name too long", { ...minimal, name: "x".repeat(81) }],
    ["missing role", { name: "A", instructions: "i" }],
    ["blank instructions", { ...minimal, instructions: " \n " }],
    ["wrong type", { ...minimal, name: 42 }],
    ["instructions too long", { ...minimal, instructions: "x".repeat(20_001) }],
    ["empty provider string", { ...minimal, providerId: "" }],
    ["enabled not boolean", { ...minimal, enabled: "yes" }],
  ])("rejects %s", (_label, input) => {
    expect(createAgentSchema.safeParse(input).success).toBe(false);
  });

  it("rejects fields that aren't part of the agent (no mass assignment)", () => {
    const result = createAgentSchema.safeParse({ ...minimal, id: "x", createdAt: new Date() });
    expect(result.success).toBe(false);
  });
});

describe("validateAgentInput", () => {
  it("returns field errors in the shape forms use", () => {
    const result = validateAgentInput(createAgentSchema, { name: "", role: "r" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors.name).toEqual(["Name can’t be empty."]);
      expect(result.fieldErrors.instructions).toBeDefined();
      expect(result.fieldErrors.role).toBeUndefined();
    }
  });
});

describe("updateAgentSchema", () => {
  it("accepts a partial change", () => {
    expect(updateAgentSchema.parse({ role: "Planner" })).toEqual({ role: "Planner" });
  });

  it("rejects an empty change", () => {
    expect(updateAgentSchema.safeParse({}).success).toBe(false);
  });

  it("does not allow clearing required fields", () => {
    expect(updateAgentSchema.safeParse({ instructions: "" }).success).toBe(false);
    expect(updateAgentSchema.safeParse({ role: "  " }).success).toBe(false);
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
