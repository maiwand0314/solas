import { z } from "zod";

// Input rules for agents. Everything that arrives from outside (a form, an
// action call, the CLI) passes through these schemas before it reaches the
// database. Strict objects reject unknown keys, so callers can't set `id`,
// `createdAt`, or any column we didn't mean to expose.

export const AGENT_LIMITS = {
  name: 80,
  description: 500,
  role: 120,
  instructions: 20_000,
  identifier: 100,
} as const;

const name = z
  .string({ error: "Name must be text." })
  .trim()
  .min(1, { error: "Name is required." })
  .max(AGENT_LIMITS.name, { error: `Name must be at most ${AGENT_LIMITS.name} characters.` });

function text(label: string, max: number) {
  return z
    .string({ error: `${label} must be text.` })
    .trim()
    .max(max, { error: `${label} must be at most ${max.toLocaleString("en")} characters.` });
}

/** Provider and model IDs: short identifiers, or null for "not configured". */
function identifier(label: string) {
  return z
    .string({ error: `${label} must be text.` })
    .trim()
    .min(1, { error: `${label} can’t be empty. Use null to clear it.` })
    .max(AGENT_LIMITS.identifier, { error: `${label} is too long.` })
    .nullable();
}

const fields = {
  name,
  description: text("Description", AGENT_LIMITS.description),
  role: text("Role", AGENT_LIMITS.role),
  instructions: text("Instructions", AGENT_LIMITS.instructions),
  providerId: identifier("Provider"),
  modelId: identifier("Model"),
  enabled: z.boolean({ error: "Enabled must be true or false." }),
};

export const createAgentSchema = z.strictObject({
  name: fields.name,
  description: fields.description.default(""),
  role: fields.role.default(""),
  instructions: fields.instructions.default(""),
  providerId: fields.providerId.default(null),
  modelId: fields.modelId.default(null),
  enabled: fields.enabled.default(true),
});

export const updateAgentSchema = z
  .strictObject({
    name: fields.name.optional(),
    description: fields.description.optional(),
    role: fields.role.optional(),
    instructions: fields.instructions.optional(),
    providerId: fields.providerId.optional(),
    modelId: fields.modelId.optional(),
    enabled: fields.enabled.optional(),
  })
  .refine((changes) => Object.keys(changes).length > 0, { error: "Nothing to update." });

export const agentIdSchema = z.uuid({ error: "Agent ID must be a valid UUID." });

export const enabledSchema = fields.enabled;

export type CreateAgentInput = z.input<typeof createAgentSchema>;
export type UpdateAgentInput = z.input<typeof updateAgentSchema>;
