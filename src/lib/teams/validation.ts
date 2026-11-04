import { z } from "zod";

// Input rules for teams, shared by the team form (instant feedback) and the
// server (which checks again, because the browser can't be trusted).

export const TEAM_LIMITS = {
  name: 80,
  description: 500,
  /** Agents in one team. A team is a working group, not a directory. */
  members: 30,
} as const;

const name = z
  .string({ error: "Name must be text." })
  .trim()
  .min(1, { error: "Give the team a name." })
  .max(TEAM_LIMITS.name, { error: `Names can be at most ${TEAM_LIMITS.name} characters.` });

const description = z
  .string({ error: "Description must be text." })
  .trim()
  .max(TEAM_LIMITS.description, { error: `Descriptions can be at most ${TEAM_LIMITS.description} characters.` });

const memberIds = z
  .array(z.uuid({ error: "Choose agents from the list." }), { error: "Members must be a list." })
  .max(TEAM_LIMITS.members, { error: `A team can have at most ${TEAM_LIMITS.members} agents.` })
  .refine((ids) => new Set(ids).size === ids.length, { error: "An agent is listed twice." });

/** The coordinator, if any, must be one of the members (checked on the whole object). */
const coordinatorId = z.uuid({ error: "Choose the coordinator from the members." }).nullable();

function coordinatorIsMember(team: { memberIds?: string[]; coordinatorId?: string | null }) {
  return !team.coordinatorId || !team.memberIds || team.memberIds.includes(team.coordinatorId);
}
const coordinatorRule = { error: "The coordinator must be a member of the team.", path: ["coordinatorId"] };

export const createTeamSchema = z
  .strictObject({
    name,
    description: description.default(""),
    memberIds: memberIds.default([]),
    coordinatorId: coordinatorId.default(null),
  })
  .refine(coordinatorIsMember, coordinatorRule);

export const updateTeamSchema = z
  .strictObject({
    name: name.optional(),
    description: description.optional(),
    memberIds: memberIds.optional(),
    coordinatorId: coordinatorId.optional(),
  })
  .refine((changes) => Object.keys(changes).length > 0, { error: "Nothing to update." })
  .refine(coordinatorIsMember, coordinatorRule);

/** One member's delegation targets inside a team (M5A permissions, edited from the team page). */
export const teamDelegationSchema = z.strictObject({
  agentId: z.uuid({ error: "Invalid agent." }),
  targetIds: memberIds,
});

export type CreateTeamInput = z.input<typeof createTeamSchema>;
export type UpdateTeamInput = z.input<typeof updateTeamSchema>;
