import "server-only";
import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { createTeamSchema, teamDelegationSchema, updateTeamSchema } from "@/lib/teams/validation";
import { getDatabase, type Database } from "@/server/db/client";
import {
  agentDelegationTargets,
  agents,
  agentToolPermissions,
  taskEvents,
  tasks,
  teamMembers,
  teams,
  type TaskEventRow,
  type TaskRow,
  type TeamRole,
  type TeamRow,
} from "@/server/db/schema";
import {
  describeModelSelection,
  getAgentReadiness,
  providerRegistry,
  type ProviderRegistry,
} from "@/server/providers/registry";
import { DELEGATION_LIMITS } from "@/server/runs/config";
import { toolRegistry, type ToolRegistry } from "@/server/tools/registry";
import { TeamServiceError, fromDatabaseError, validationError } from "./errors";

// Teams (M5B): named groups of agents with one optional coordinator. A team
// is organisation, not permission: delegation between members still needs
// the explicit targets from M5A, which the team page edits and the backend
// checks on every delegation. Deleting a team removes its membership rows;
// agents, tasks, and history stay.

export type TeamSummary = Pick<TeamRow, "id" | "name" | "description" | "createdAt" | "updatedAt"> & {
  coordinator: { id: string; name: string } | null;
  members: { id: string; name: string }[];
  /** Tasks given to this team. */
  taskCount: number;
};

/** One member as the team page shows it: identity, status, capabilities, delegation. */
export type TeamMemberView = {
  id: string;
  name: string;
  /** The agent's own role text from Agent Builder, e.g. "research". */
  agentRole: string;
  teamRole: TeamRole;
  enabled: boolean;
  /** "Claude · Opus 5.5", or null when no model is set. */
  modelLabel: string | null;
  readiness: "ready" | "disabled" | "unconfigured";
  /** Names of the agent's enabled tools. */
  tools: string[];
  /** Everyone this agent may delegate to, inside or outside the team. */
  delegatesTo: { id: string; name: string; inTeam: boolean }[];
};

export type TeamTaskView = Pick<
  TaskRow,
  "id" | "title" | "status" | "cancelRequestedAt" | "parentTaskId" | "createdAt" | "updatedAt"
> & { agentId: string; agentName: string };

export type TeamActivityView = Pick<TaskEventRow, "id" | "type" | "message" | "createdAt"> & {
  taskId: string;
  taskTitle: string;
  agentName: string;
};

export type TeamDetail = {
  team: TeamRow;
  members: TeamMemberView[];
  tasks: TeamTaskView[];
  taskCount: number;
  activity: TeamActivityView[];
};

/** A team as the New task form needs it: who may take its tasks. */
export type TeamOption = { id: string; name: string; memberIds: string[] };

const idSchema = z.uuid({ error: "Invalid team." });
/** The newest team tasks and events shown on the team page. */
const RECENT_TASKS = 20;
const RECENT_EVENTS = 15;

type Dependencies = {
  db: Database;
  providers: ProviderRegistry;
  tools?: ToolRegistry;
};

export function createTeamService({ db, providers, tools = toolRegistry }: Dependencies) {
  async function list(): Promise<TeamSummary[]> {
    const [rows, memberRows, counts] = await Promise.all([
      query(() => db.select().from(teams).orderBy(sql`lower(${teams.name})`)),
      query(() =>
        db
          .select({ teamId: teamMembers.teamId, id: agents.id, name: agents.name, role: teamMembers.role })
          .from(teamMembers)
          .innerJoin(agents, eq(agents.id, teamMembers.agentId))
          .orderBy(sql`lower(${agents.name})`),
      ),
      query(() =>
        db
          .select({ teamId: tasks.teamId, count: sql<number>`count(*)::int` })
          .from(tasks)
          .where(sql`${tasks.teamId} is not null`)
          .groupBy(tasks.teamId),
      ),
    ]);
    return rows.map((team) => {
      const members = memberRows.filter((row) => row.teamId === team.id);
      const coordinator = members.find((row) => row.role === "coordinator");
      return {
        ...team,
        coordinator: coordinator ? { id: coordinator.id, name: coordinator.name } : null,
        members: members.map(({ id, name }) => ({ id, name })),
        taskCount: counts.find((row) => row.teamId === team.id)?.count ?? 0,
      };
    });
  }

  async function get(id: unknown): Promise<TeamDetail> {
    const team = await getTeamRow(parse(idSchema, id));
    const [members, teamTasks, [{ count }], activity] = await Promise.all([
      membersOf(team.id),
      query(() =>
        db
          .select({
            id: tasks.id,
            title: tasks.title,
            status: tasks.status,
            cancelRequestedAt: tasks.cancelRequestedAt,
            parentTaskId: tasks.parentTaskId,
            createdAt: tasks.createdAt,
            updatedAt: tasks.updatedAt,
            agentId: agents.id,
            agentName: agents.name,
          })
          .from(tasks)
          .innerJoin(agents, eq(agents.id, tasks.agentId))
          .where(eq(tasks.teamId, team.id))
          .orderBy(desc(tasks.updatedAt))
          .limit(RECENT_TASKS),
      ),
      query(() => db.select({ count: sql<number>`count(*)::int` }).from(tasks).where(eq(tasks.teamId, team.id))),
      query(() =>
        db
          .select({
            id: taskEvents.id,
            type: taskEvents.type,
            message: taskEvents.message,
            createdAt: taskEvents.createdAt,
            taskId: tasks.id,
            taskTitle: tasks.title,
            agentName: agents.name,
          })
          .from(taskEvents)
          .innerJoin(tasks, eq(tasks.id, taskEvents.taskId))
          .innerJoin(agents, eq(agents.id, tasks.agentId))
          .where(eq(tasks.teamId, team.id))
          .orderBy(desc(taskEvents.id))
          .limit(RECENT_EVENTS),
      ),
    ]);
    return { team, members, tasks: teamTasks, taskCount: count, activity };
  }

  async function membersOf(teamId: string): Promise<TeamMemberView[]> {
    const rows = await query(() =>
      db
        .select({ agent: agents, teamRole: teamMembers.role })
        .from(teamMembers)
        .innerJoin(agents, eq(agents.id, teamMembers.agentId))
        .where(eq(teamMembers.teamId, teamId))
        .orderBy(sql`${teamMembers.role} <> 'coordinator'`, sql`lower(${agents.name})`),
    );
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.agent.id);
    const [permissions, targets] = await Promise.all([
      query(() =>
        db
          .select({ agentId: agentToolPermissions.agentId, toolId: agentToolPermissions.toolId })
          .from(agentToolPermissions)
          .where(inArray(agentToolPermissions.agentId, ids)),
      ),
      query(() =>
        db
          .select({ agentId: agentDelegationTargets.agentId, id: agents.id, name: agents.name })
          .from(agentDelegationTargets)
          .innerJoin(agents, eq(agents.id, agentDelegationTargets.targetAgentId))
          .where(inArray(agentDelegationTargets.agentId, ids))
          .orderBy(sql`lower(${agents.name})`),
      ),
    ]);
    const order = tools.list().map((tool) => tool.id);
    return rows.map(({ agent, teamRole }) => ({
      id: agent.id,
      name: agent.name,
      agentRole: agent.role,
      teamRole,
      enabled: agent.enabled,
      modelLabel: describeModelSelection(providers, agent),
      readiness: getAgentReadiness(agent, providers).state,
      tools: permissions
        .filter((row) => row.agentId === agent.id && tools.get(row.toolId))
        .sort((a, b) => order.indexOf(a.toolId) - order.indexOf(b.toolId))
        .map((row) => tools.get(row.toolId)!.name),
      delegatesTo: targets
        .filter((row) => row.agentId === agent.id)
        .map(({ id, name }) => ({ id, name, inTeam: ids.includes(id) })),
    }));
  }

  async function create(input: unknown): Promise<TeamRow> {
    const { memberIds, coordinatorId, ...values } = parse(createTeamSchema, input);
    await assertAgentsExist(memberIds);
    return query(() =>
      db.transaction(async (tx) => {
        const [team] = await tx.insert(teams).values(values).returning();
        if (memberIds.length > 0) {
          await tx.insert(teamMembers).values(
            memberIds.map((agentId) => ({
              teamId: team.id,
              agentId,
              role: (agentId === coordinatorId ? "coordinator" : "member") as TeamRole,
            })),
          );
        }
        return team;
      }),
    );
  }

  /**
   * Changes a team's details, members, or coordinator. Members are replaced
   * as a set; a removed coordinator stops being coordinator. A new
   * coordinator must be a member after the change.
   */
  async function update(id: unknown, input: unknown): Promise<TeamRow> {
    const teamId = parse(idSchema, id);
    const { memberIds, coordinatorId, ...changes } = parse(updateTeamSchema, input);
    await getTeamRow(teamId);
    if (memberIds) await assertAgentsExist(memberIds);
    if (coordinatorId && !memberIds) {
      const [member] = await query(() =>
        db
          .select({ agentId: teamMembers.agentId })
          .from(teamMembers)
          .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.agentId, coordinatorId))),
      );
      if (!member) {
        const message = "The coordinator must be a member of the team.";
        throw new TeamServiceError("validation_failed", message, { coordinatorId: [message] });
      }
    }

    return query(() =>
      db.transaction(async (tx) => {
        const [team] = await tx
          .update(teams)
          .set({ ...changes, updatedAt: sql`now()` })
          .where(eq(teams.id, teamId))
          .returning();
        if (memberIds) {
          await tx
            .delete(teamMembers)
            .where(
              memberIds.length > 0
                ? and(eq(teamMembers.teamId, teamId), notInArray(teamMembers.agentId, memberIds))
                : eq(teamMembers.teamId, teamId),
            );
          if (memberIds.length > 0) {
            await tx
              .insert(teamMembers)
              .values(memberIds.map((agentId) => ({ teamId, agentId })))
              .onConflictDoNothing();
          }
        }
        if (coordinatorId !== undefined) {
          // Demote first, then promote: the "one coordinator" index holds at every step.
          await tx.update(teamMembers).set({ role: "member" }).where(eq(teamMembers.teamId, teamId));
          if (coordinatorId) {
            await tx
              .update(teamMembers)
              .set({ role: "coordinator" })
              .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.agentId, coordinatorId)));
          }
        }
        return team;
      }),
    );
  }

  /** Deletes the team and its membership rows. Agents and tasks stay; tasks lose only the team link. */
  async function remove(id: unknown): Promise<void> {
    const teamId = parse(idSchema, id);
    const deleted = await query(() => db.delete(teams).where(eq(teams.id, teamId)).returning({ id: teams.id }));
    if (deleted.length === 0) throw notFound();
  }

  /**
   * Sets which other members one member may delegate to (the M5A delegation
   * targets), from the team page. Only targets inside this team are changed;
   * targets in other teams stay as they are. Being in a team grants nothing:
   * this is the explicit permission the backend checks on every delegation.
   */
  async function setDelegation(id: unknown, input: unknown): Promise<TeamMemberView[]> {
    const teamId = parse(idSchema, id);
    const { agentId, targetIds } = parse(teamDelegationSchema, input);
    await getTeamRow(teamId);
    const memberIds = (
      await query(() => db.select({ agentId: teamMembers.agentId }).from(teamMembers).where(eq(teamMembers.teamId, teamId)))
    ).map((row) => row.agentId);
    const fail = (message: string) => {
      throw new TeamServiceError("validation_failed", message, { targetIds: [message] });
    };
    if (!memberIds.includes(agentId)) fail("This agent isn’t a member of the team.");
    if (targetIds.includes(agentId)) fail("An agent can’t delegate to itself.");
    if (targetIds.some((target) => !memberIds.includes(target))) fail("Choose targets from this team’s members.");

    const others = await query(() =>
      db
        .select({ id: agentDelegationTargets.targetAgentId })
        .from(agentDelegationTargets)
        .where(and(eq(agentDelegationTargets.agentId, agentId), notInArray(agentDelegationTargets.targetAgentId, memberIds))),
    );
    if (others.length + targetIds.length > DELEGATION_LIMITS.maxTargetsPerAgent) {
      fail(`An agent can delegate to at most ${DELEGATION_LIMITS.maxTargetsPerAgent} agents.`);
    }

    await query(() =>
      db.transaction(async (tx) => {
        await tx
          .delete(agentDelegationTargets)
          .where(and(eq(agentDelegationTargets.agentId, agentId), inArray(agentDelegationTargets.targetAgentId, memberIds)));
        if (targetIds.length > 0) {
          await tx.insert(agentDelegationTargets).values(targetIds.map((targetAgentId) => ({ agentId, targetAgentId })));
        }
        // Like any agent edit: the agent's "updated" time moves, and the change applies from its next run.
        await tx.update(agents).set({ updatedAt: sql`now()` }).where(eq(agents.id, agentId));
      }),
    );
    return membersOf(teamId);
  }

  /** The teams an agent belongs to, for its page. */
  async function teamsOfAgent(agentId: string): Promise<{ id: string; name: string; role: TeamRole }[]> {
    return query(() =>
      db
        .select({ id: teams.id, name: teams.name, role: teamMembers.role })
        .from(teamMembers)
        .innerJoin(teams, eq(teams.id, teamMembers.teamId))
        .where(eq(teamMembers.agentId, agentId))
        .orderBy(sql`lower(${teams.name})`),
    );
  }

  /** Teams with their member IDs, for the New task form. */
  async function options(): Promise<TeamOption[]> {
    const [rows, members] = await Promise.all([
      query(() => db.select({ id: teams.id, name: teams.name }).from(teams).orderBy(asc(sql`lower(${teams.name})`))),
      query(() => db.select({ teamId: teamMembers.teamId, agentId: teamMembers.agentId }).from(teamMembers)),
    ]);
    return rows.map((team) => ({
      ...team,
      memberIds: members.filter((row) => row.teamId === team.id).map((row) => row.agentId),
    }));
  }

  async function assertAgentsExist(ids: string[]) {
    if (ids.length === 0) return;
    const found = await query(() => db.select({ id: agents.id }).from(agents).where(inArray(agents.id, ids)));
    if (found.length !== ids.length) {
      const message = "One of the chosen agents no longer exists. Reload and choose again.";
      throw new TeamServiceError("validation_failed", message, { memberIds: [message] });
    }
  }

  async function getTeamRow(id: string): Promise<TeamRow> {
    const [team] = await query(() => db.select().from(teams).where(eq(teams.id, id)).limit(1));
    if (!team) throw notFound();
    return team;
  }

  return { list, get, create, update, remove, setDelegation, teamsOfAgent, options };
}

export type TeamService = ReturnType<typeof createTeamService>;

export function getTeamService(): TeamService {
  return createTeamService({ db: getDatabase(), providers: providerRegistry });
}

function notFound() {
  return new TeamServiceError("not_found", "This team doesn’t exist. It may have been deleted.");
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
    if (error instanceof TeamServiceError) throw error;
    throw fromDatabaseError(error);
  }
}
