import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, createDatabase } from "@/server/db/client";
import { agents } from "@/server/db/schema";
import { createProviderRegistry, providerRegistry } from "@/server/providers/registry";
import { AgentServiceError } from "./errors";
import { createAgentService } from "./service";

// Integration tests: these talk to the real PostgreSQL test database
// (TEST_DATABASE_URL), which src/test/global-setup.ts creates and migrates.

const testUrl = process.env.TEST_DATABASE_URL!;
const db = createDatabase(testUrl);
const service = createAgentService({ db, providers: providerRegistry });

// A registry with one usable provider, to test the "configured" path that the
// real registry doesn't offer yet.
const availableProviders = createProviderRegistry([
  { id: "test-provider", label: "Test provider", status: "available", models: [{ id: "test-model", label: "Test" }] },
]);

const MISSING_ID = "00000000-0000-4000-8000-000000000000";

/** A valid agent with the required fields; override what a test cares about. */
function agentInput(overrides: Record<string, unknown> = {}) {
  return { name: "Researcher", role: "research", instructions: "Research topics.", ...overrides };
}

async function expectAgentError(promise: Promise<unknown>, code: AgentServiceError["code"]) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AgentServiceError);
  expect((error as AgentServiceError).code).toBe(code);
  return error as AgentServiceError;
}

async function countAgents() {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(agents);
  return row.count;
}

beforeEach(async () => {
  await db.delete(agents);
});

afterAll(async () => {
  await closeDatabase(db);
});

describe("database connection", () => {
  it("connects to the test database", async () => {
    const [row] = await db.execute<{ database: string }>(sql`select current_database() as database`);
    expect(row.database).toMatch(/_test$/);
  });
});

describe("agent service", () => {
  it("creates an agent with an id, defaults, and timestamps", async () => {
    const agent = await service.create(agentInput({ name: "Researcher", role: "Finds sources" }));

    expect(agent.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(agent).toMatchObject({
      name: "Researcher",
      role: "Finds sources",
      description: "",
      instructions: "Research topics.",
      providerId: null,
      modelId: null,
      enabled: true,
    });
    expect(agent.createdAt).toBeInstanceOf(Date);
    expect(agent.updatedAt.getTime()).toBe(agent.createdAt.getTime());
  });

  it("reads an agent by id and lists agents by name", async () => {
    const writer = await service.create(agentInput({ name: "writer" }));
    await service.create(agentInput({ name: "Analyst" }));

    expect(await service.get(writer.id)).toEqual(writer);
    expect((await service.list()).map((agent) => agent.name)).toEqual(["Analyst", "writer"]);
  });

  it("updates only the given fields and moves updatedAt forward", async () => {
    const original = await service.create(agentInput({ name: "Planner", description: "Plans the week" }));
    // Timestamps are compared in milliseconds; make sure at least one passes.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = await service.update(original.id, { instructions: "Be concise." });

    expect(updated).toMatchObject({ name: "Planner", description: "Plans the week", instructions: "Be concise." });
    expect(updated.createdAt).toEqual(original.createdAt);
    expect(updated.updatedAt.getTime()).toBeGreaterThan(original.updatedAt.getTime());
  });

  it("enables and disables an agent", async () => {
    const agent = await service.create(agentInput({ name: "Scheduler" }));
    expect((await service.setEnabled(agent.id, false)).enabled).toBe(false);
    expect((await service.setEnabled(agent.id, true)).enabled).toBe(true);
    await expectAgentError(service.setEnabled(agent.id, "off"), "validation_failed");
  });

  it("deletes an agent", async () => {
    const agent = await service.create(agentInput({ name: "Temporary" }));
    await service.remove(agent.id);

    await expectAgentError(service.get(agent.id), "not_found");
    await expectAgentError(service.remove(agent.id), "not_found");
  });

  it("rejects invalid input with field errors and writes nothing", async () => {
    const error = await expectAgentError(service.create(agentInput({ name: "", role: 5 })), "validation_failed");

    expect(error.fieldErrors.name).toBeDefined();
    expect(error.fieldErrors.role).toBeDefined();
    expect(await countAgents()).toBe(0);
  });

  it("rejects malformed and unknown ids", async () => {
    await expectAgentError(service.get("not-a-uuid"), "validation_failed");
    await expectAgentError(service.get(MISSING_ID), "not_found");
    await expectAgentError(service.update(MISSING_ID, { name: "X" }), "not_found");
  });

  it("rejects a duplicate name, ignoring letter case", async () => {
    await service.create(agentInput({ name: "Researcher" }));
    const error = await expectAgentError(service.create(agentInput({ name: "RESEARCHER" })), "name_taken");

    expect(error.fieldErrors.name).toEqual(["An agent with this name already exists."]);
    expect(await countAgents()).toBe(1);
  });
});

describe("provider and model selection", () => {
  it("refuses providers that aren't available yet", async () => {
    const error = await expectAgentError(
      service.create(agentInput({ name: "Coder", providerId: "claude-agent-sdk", modelId: "any" })),
      "validation_failed",
    );
    expect(error.fieldErrors.providerId?.[0]).toContain("can’t be used yet");
  });

  it("accepts a provider and model from the registry", async () => {
    const withProviders = createAgentService({ db, providers: availableProviders });
    const agent = await withProviders.create(agentInput({ name: "Coder", providerId: "test-provider", modelId: "test-model" }));

    expect(agent).toMatchObject({ providerId: "test-provider", modelId: "test-model" });
    await expectAgentError(withProviders.update(agent.id, { modelId: "unknown-model" }), "validation_failed");
    expect((await withProviders.update(agent.id, { providerId: null, modelId: null })).providerId).toBeNull();
  });

  it("is backed by a database constraint as well", async () => {
    // Bypass the service to prove the database itself rejects half a selection.
    const error = await db
      .insert(agents)
      .values({ ...agentInput({ name: "Half" }), providerId: "test-provider" })
      .then(() => null, (caught: unknown) => caught);
    expect(error).not.toBeNull();
  });
});

describe("duplicate", () => {
  it("copies the configuration into a new, disabled agent with a new id", async () => {
    const source = await service.create(
      agentInput({ name: "Research Assistant", description: "Writes reports", instructions: "Be thorough." }),
    );
    const copy = await service.duplicate(source.id);

    expect(copy.id).not.toBe(source.id);
    expect(copy).toMatchObject({
      name: "Research Assistant (copy)",
      role: source.role,
      description: "Writes reports",
      instructions: "Be thorough.",
      enabled: false,
    });
    expect(copy.createdAt.getTime()).toBeGreaterThanOrEqual(source.createdAt.getTime());
    expect(await service.get(source.id)).toEqual(source);
  });

  it("numbers further copies so names stay unique", async () => {
    const source = await service.create(agentInput({ name: "Writer" }));
    await service.duplicate(source.id);
    const second = await service.duplicate(source.id);
    expect(second.name).toBe("Writer (copy 2)");
  });

  it("shortens long names so the copy still fits the name limit", async () => {
    const source = await service.create(agentInput({ name: "x".repeat(80) }));
    const copy = await service.duplicate(source.id);
    expect(copy.name).toHaveLength(80);
    expect(copy.name.endsWith(" (copy)")).toBe(true);
  });

  it("reports a missing source agent", async () => {
    await expectAgentError(service.duplicate(MISSING_ID), "not_found");
  });
});

describe("persistence and failure handling", () => {
  it("keeps agents after the connection pool is closed and reopened (a restart)", async () => {
    const created = await service.create(agentInput({ name: "Survivor" }));

    const otherProcess = createDatabase(testUrl);
    try {
      const reread = await createAgentService({ db: otherProcess, providers: providerRegistry }).get(created.id);
      expect(reread).toEqual(created);
    } finally {
      await closeDatabase(otherProcess);
    }
  });

  it("reports an unreachable database clearly instead of crashing", async () => {
    // Port 1 on this machine has no PostgreSQL behind it.
    const unreachable = createDatabase("postgres://solas:wrong@127.0.0.1:1/solas_test");
    try {
      const offline = createAgentService({ db: unreachable, providers: providerRegistry });
      const error = await expectAgentError(offline.list(), "database_unavailable");
      expect(error.message).toContain("npm run db:up");
    } finally {
      await closeDatabase(unreachable);
    }
  });
});
