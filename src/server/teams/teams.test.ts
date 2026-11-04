import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createAgentService } from "@/server/agents/service";
import { closeDatabase, createDatabase } from "@/server/db/client";
import { agentDelegationTargets, agents, agentToolPermissions, runs, tasks, teamMembers, teams } from "@/server/db/schema";
import { insertAgent, testProviders } from "@/server/runs/test-helpers";
import { delegate } from "@/server/tasks/delegation";
import { createTaskService } from "@/server/tasks/service";
import { createTeamService } from "./service";

// Teams (M5B) against the test database: the team service, its effect on
// delegation permissions, and how tasks are linked to teams.

const db = createDatabase(process.env.TEST_DATABASE_URL!);
const teamsService = createTeamService({ db, providers: testProviders });
const taskService = createTaskService({ db, providers: testProviders, limits: { taskAutoRetries: 1 } });
const agentService = createAgentService({ db, providers: testProviders });

async function trio() {
  const manager = await insertAgent(db, { name: "Project Manager", role: "planning" });
  const developer = await insertAgent(db, { name: "Developer", role: "engineering" });
  const researcher = await insertAgent(db, { name: "Research Assistant", role: "research" });
  return { manager, developer, researcher };
}

async function membersOf(teamId: string) {
  return db.select().from(teamMembers).where(eq(teamMembers.teamId, teamId));
}

async function targetsOf(agentId: string) {
  return (await db.select().from(agentDelegationTargets).where(eq(agentDelegationTargets.agentId, agentId)))
    .map((row) => row.targetAgentId)
    .sort();
}

beforeEach(async () => {
  await db.delete(teams);
  await db.delete(agents);
});

afterAll(async () => {
  await closeDatabase(db);
});

describe("teams", () => {
  it("creates a team with members and a coordinator, and lists it", async () => {
    const { manager, developer, researcher } = await trio();
    const team = await teamsService.create({
      name: "Solas Development Team",
      description: "Builds Solas.",
      memberIds: [manager.id, developer.id, researcher.id],
      coordinatorId: manager.id,
    });

    const rows = await membersOf(team.id);
    expect(rows.map((row) => [row.agentId, row.role]).sort()).toEqual(
      [
        [manager.id, "coordinator"],
        [developer.id, "member"],
        [researcher.id, "member"],
      ].sort(),
    );
    const [listed] = await teamsService.list();
    expect(listed).toMatchObject({
      name: "Solas Development Team",
      description: "Builds Solas.",
      coordinator: { id: manager.id, name: "Project Manager" },
      taskCount: 0,
    });
    expect(listed.members.map((member) => member.name)).toEqual(["Developer", "Project Manager", "Research Assistant"]);
  });

  it("validates input: name, unique name, unknown agents, and a coordinator who isn't a member", async () => {
    const { manager, developer } = await trio();
    await expect(teamsService.create({ name: "  " })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(teamsService.create({ name: "A", unknown: true })).rejects.toMatchObject({ code: "validation_failed" });
    await teamsService.create({ name: "Core" });
    await expect(teamsService.create({ name: "core" })).rejects.toMatchObject({ code: "name_taken" });
    await expect(teamsService.create({ name: "Ghosts", memberIds: [crypto.randomUUID()] })).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(
      teamsService.create({ name: "Bad", memberIds: [developer.id], coordinatorId: manager.id }),
    ).rejects.toMatchObject({ fieldErrors: { coordinatorId: ["The coordinator must be a member of the team."] } });
    await expect(
      teamsService.create({ name: "Twice", memberIds: [developer.id, developer.id] }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("updates details, adds and removes members, and changes the coordinator", async () => {
    const { manager, developer, researcher } = await trio();
    const team = await teamsService.create({ name: "Team", memberIds: [manager.id], coordinatorId: manager.id });

    await teamsService.update(team.id, { name: "Renamed", description: "New." });
    await teamsService.update(team.id, { memberIds: [manager.id, developer.id, researcher.id] });
    expect((await membersOf(team.id)).find((row) => row.agentId === manager.id)?.role).toBe("coordinator");

    await teamsService.update(team.id, { coordinatorId: developer.id });
    const afterSwap = await membersOf(team.id);
    expect(afterSwap.filter((row) => row.role === "coordinator").map((row) => row.agentId)).toEqual([developer.id]);

    // Removing the coordinator leaves the team without one.
    await teamsService.update(team.id, { memberIds: [manager.id, researcher.id] });
    expect((await membersOf(team.id)).every((row) => row.role === "member")).toBe(true);
    // A coordinator must already be a member.
    await expect(teamsService.update(team.id, { coordinatorId: developer.id })).rejects.toMatchObject({
      code: "validation_failed",
    });
    await teamsService.update(team.id, { coordinatorId: null });
    const detail = await teamsService.get(team.id);
    expect(detail.team).toMatchObject({ name: "Renamed", description: "New." });
  });

  it("can't hold an agent twice, or two coordinators, even bypassing the service", async () => {
    const { manager, developer } = await trio();
    const team = await teamsService.create({ name: "Team", memberIds: [manager.id, developer.id], coordinatorId: manager.id });
    await expect(db.insert(teamMembers).values({ teamId: team.id, agentId: developer.id })).rejects.toThrow();
    await expect(
      db.update(teamMembers).set({ role: "coordinator" }).where(eq(teamMembers.agentId, developer.id)),
    ).rejects.toThrow();
  });

  it("deletes a team without deleting its agents or tasks", async () => {
    const { manager, developer } = await trio();
    const team = await teamsService.create({ name: "Team", memberIds: [manager.id, developer.id] });
    const { taskId } = await taskService.create({
      agentId: developer.id,
      teamId: team.id,
      title: "Build the page",
      instructions: "Build it.",
    });

    await teamsService.remove(team.id);
    expect(await db.select().from(teams)).toEqual([]);
    expect(await db.select().from(teamMembers)).toEqual([]);
    expect(await db.select().from(agents)).toHaveLength(3);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(task).toMatchObject({ title: "Build the page", teamId: null }); // kept, only the link is gone
    expect(await db.select().from(runs).where(eq(runs.taskId, taskId))).toHaveLength(1);
    await expect(teamsService.remove(team.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("drops a deleted agent's membership, and its coordinator role with it", async () => {
    const { manager, developer } = await trio();
    const team = await teamsService.create({ name: "Team", memberIds: [manager.id, developer.id], coordinatorId: manager.id });
    await agentService.remove(manager.id);
    expect((await membersOf(team.id)).map((row) => row.agentId)).toEqual([developer.id]);
    expect((await teamsService.list())[0].coordinator).toBeNull();
  });

  it("shows each member's status and capabilities, including disabled and unconfigured agents", async () => {
    const { manager, developer } = await trio();
    const idle = await insertAgent(db, { name: "Idle", enabled: false });
    const blank = await insertAgent(db, { name: "Blank", providerId: null, modelId: null });
    await db.insert(agentToolPermissions).values({ agentId: developer.id, toolId: "read_workspace_file", mode: "ask" });
    const team = await teamsService.create({
      name: "Team",
      memberIds: [manager.id, developer.id, idle.id, blank.id],
      coordinatorId: manager.id,
    });
    const { members } = await teamsService.get(team.id);
    expect(members[0]).toMatchObject({ name: "Project Manager", teamRole: "coordinator" }); // coordinator first
    expect(members.find((member) => member.id === developer.id)).toMatchObject({
      agentRole: "engineering",
      readiness: "ready",
      modelLabel: "Fake · Fake model",
      tools: ["Read workspace file"],
    });
    expect(members.find((member) => member.id === idle.id)).toMatchObject({ enabled: false, readiness: "disabled" });
    expect(members.find((member) => member.id === blank.id)).toMatchObject({ readiness: "unconfigured", modelLabel: null });
  });
});

describe("delegation inside a team", () => {
  it("being a member, or the coordinator, grants no delegation by itself", async () => {
    const { manager, developer } = await trio();
    const team = await teamsService.create({ name: "Team", memberIds: [manager.id, developer.id], coordinatorId: manager.id });
    expect(await targetsOf(manager.id)).toEqual([]);
    const { members } = await teamsService.get(team.id);
    expect(members.every((member) => member.delegatesTo.length === 0)).toBe(true);

    // The backend refuses a delegation the coordinator was never given.
    const { taskId } = await taskService.create({ agentId: manager.id, teamId: team.id, title: "Plan", instructions: "Plan it." });
    await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, taskId));
    const [run] = await db.select().from(runs).where(eq(runs.taskId, taskId));
    await expect(
      delegate(db, {
        run,
        request: { targetAgentId: developer.id, taskDescription: "Build the settings page, please." },
        providers: testProviders,
        autoRetries: 1,
      }),
    ).rejects.toThrow("You may not delegate to that agent");
  });

  it("sets a member's targets within the team only, keeps targets outside it, and shows them", async () => {
    const { manager, developer, researcher } = await trio();
    const outsider = await insertAgent(db, { name: "Outsider" });
    await db.insert(agentDelegationTargets).values({ agentId: manager.id, targetAgentId: outsider.id });
    const team = await teamsService.create({
      name: "Solas Development Team",
      memberIds: [manager.id, developer.id, researcher.id],
      coordinatorId: manager.id,
    });

    const members = await teamsService.setDelegation(team.id, { agentId: manager.id, targetIds: [developer.id, researcher.id] });
    expect(await targetsOf(manager.id)).toEqual([developer.id, researcher.id, outsider.id].sort());
    expect(members.find((member) => member.id === manager.id)?.delegatesTo).toEqual([
      { id: developer.id, name: "Developer", inTeam: true },
      { id: outsider.id, name: "Outsider", inTeam: false },
      { id: researcher.id, name: "Research Assistant", inTeam: true },
    ]);

    // Narrowing it inside the team leaves the outsider alone.
    await teamsService.setDelegation(team.id, { agentId: manager.id, targetIds: [researcher.id] });
    expect(await targetsOf(manager.id)).toEqual([researcher.id, outsider.id].sort());
    // The agent's own settings agree: one source of truth.
    expect((await agentService.getDelegationTargets(manager.id)).map((target) => target.name)).toEqual([
      "Outsider",
      "Research Assistant",
    ]);
  });

  it("refuses targets outside the team, self, and non-members", async () => {
    const { manager, developer } = await trio();
    const outsider = await insertAgent(db, { name: "Outsider" });
    const team = await teamsService.create({ name: "Team", memberIds: [manager.id, developer.id] });
    for (const input of [
      { agentId: manager.id, targetIds: [outsider.id] },
      { agentId: manager.id, targetIds: [manager.id] },
      { agentId: outsider.id, targetIds: [manager.id] },
    ]) {
      await expect(teamsService.setDelegation(team.id, input)).rejects.toMatchObject({ code: "validation_failed" });
    }
    expect(await targetsOf(manager.id)).toEqual([]);
  });
});

describe("tasks and teams", () => {
  it("links a task to a team only when chosen, and only through a member", async () => {
    const { manager, developer } = await trio();
    const outsider = await insertAgent(db, { name: "Outsider" });
    const team = await teamsService.create({ name: "Team", memberIds: [manager.id, developer.id] });
    const other = await teamsService.create({ name: "Other", memberIds: [developer.id] });

    const { taskId: linked } = await taskService.create({ agentId: developer.id, teamId: team.id, title: "A", instructions: "A." });
    const { taskId: unlinked } = await taskService.create({ agentId: developer.id, title: "B", instructions: "B." });
    await expect(
      taskService.create({ agentId: outsider.id, teamId: team.id, title: "C", instructions: "C." }),
    ).rejects.toMatchObject({ fieldErrors: { teamId: ["This agent isn’t a member of the chosen team."] } });

    // Being in two teams doesn't put the task in both.
    expect((await taskService.list({ teamId: team.id })).map((task) => task.id)).toEqual([linked]);
    expect(await taskService.list({ teamId: other.id })).toEqual([]);
    expect((await taskService.list()).find((task) => task.id === unlinked)?.team).toBeNull();
    expect((await taskService.list()).find((task) => task.id === linked)?.team).toEqual({ id: team.id, name: "Team" });
    expect((await taskService.get(linked)).team).toEqual({ id: team.id, name: "Team" });
    expect((await taskService.countByFilter("", team.id)).all).toBe(1);

    const detail = await teamsService.get(team.id);
    expect(detail.taskCount).toBe(1);
    expect(detail.tasks.map((task) => task.id)).toEqual([linked]);
    expect(detail.activity.map((event) => event.type)).toEqual(["queued", "created"]); // newest first
  });

  it("keeps a task's team when membership changes later", async () => {
    const { manager, developer } = await trio();
    const team = await teamsService.create({ name: "Team", memberIds: [manager.id, developer.id] });
    const { taskId } = await taskService.create({ agentId: developer.id, teamId: team.id, title: "A", instructions: "A." });
    await teamsService.update(team.id, { memberIds: [manager.id] });
    expect((await taskService.get(taskId)).team).toEqual({ id: team.id, name: "Team" });
    expect((await teamsService.get(team.id)).tasks.map((task) => task.id)).toEqual([taskId]);
  });

  it("a delegated task stays with its parent's team", async () => {
    const { manager, developer } = await trio();
    const team = await teamsService.create({ name: "Team", memberIds: [manager.id, developer.id], coordinatorId: manager.id });
    await teamsService.setDelegation(team.id, { agentId: manager.id, targetIds: [developer.id] });
    const { taskId } = await taskService.create({ agentId: manager.id, teamId: team.id, title: "Plan", instructions: "Plan it." });
    await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, taskId));
    const [run] = await db.select().from(runs).where(eq(runs.taskId, taskId));
    const receipt = await delegate(db, {
      run,
      request: { targetAgentId: developer.id, taskDescription: "Build the settings page, please." },
      providers: testProviders,
      autoRetries: 1,
    });
    const [child] = await db.select().from(tasks).where(eq(tasks.id, receipt.childTaskId));
    expect(child.teamId).toBe(team.id);
    expect((await teamsService.get(team.id)).taskCount).toBe(2);
  });
});
