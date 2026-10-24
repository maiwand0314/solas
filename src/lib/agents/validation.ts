import { z } from "zod";

// Input rules for agents, shared by the browser and the server. The Agent
// Builder form uses them for instant feedback; the agent service runs them
// again on every write, because the browser can't be trusted. Strict objects
// reject unknown keys, so callers can't set `id`, `createdAt`, or any column
// we didn't mean to expose.

export const AGENT_LIMITS = {
  name: 80,
  description: 500,
  role: 120,
  instructions: 20_000,
  identifier: 100,
} as const;

function text(label: string, max: number) {
  return z
    .string({ error: `${label} must be text.` })
    .trim()
    .max(max, { error: `${label} must be at most ${max.toLocaleString("en")} characters.` });
}

function requiredText(label: string, max: number) {
  return text(label, max).min(1, { error: `${label} can’t be empty.` });
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

/**
 * The tools an agent may use. Only the shape is checked here (the browser
 * has no registry); the agent service checks each ID against the tool
 * registry. A tool that isn't listed is off.
 */
const toolSettings = z
  .array(
    z.strictObject({
      toolId: z.string({ error: "Tool ID must be text." }).trim().min(1).max(64),
      mode: z.enum(["allow", "ask"], { error: "Choose whether the tool runs automatically or asks first." }),
    }),
    { error: "Tools must be a list." },
  )
  .max(32, { error: "Too many tools." })
  .refine((tools) => new Set(tools.map((tool) => tool.toolId)).size === tools.length, {
    error: "A tool is listed twice.",
  });

export type AgentToolSetting = z.output<typeof toolSettings>[number];

const fields = {
  name: requiredText("Name", AGENT_LIMITS.name),
  role: requiredText("Role", AGENT_LIMITS.role),
  description: text("Description", AGENT_LIMITS.description),
  instructions: requiredText("Instructions", AGENT_LIMITS.instructions),
  providerId: identifier("Provider"),
  modelId: identifier("Model"),
  enabled: z.boolean({ error: "Enabled must be true or false." }),
  tools: toolSettings,
};

export const createAgentSchema = z.strictObject({
  name: fields.name,
  role: fields.role,
  description: fields.description.default(""),
  instructions: fields.instructions,
  providerId: fields.providerId.default(null),
  modelId: fields.modelId.default(null),
  enabled: fields.enabled.default(true),
  tools: fields.tools.default([]),
});

export const updateAgentSchema = z
  .strictObject({
    name: fields.name.optional(),
    role: fields.role.optional(),
    description: fields.description.optional(),
    instructions: fields.instructions.optional(),
    providerId: fields.providerId.optional(),
    modelId: fields.modelId.optional(),
    enabled: fields.enabled.optional(),
    tools: fields.tools.optional(),
  })
  .refine((changes) => Object.keys(changes).length > 0, { error: "Nothing to update." });

export const agentIdSchema = z.uuid({ error: "Agent ID must be a valid UUID." });

export const enabledSchema = fields.enabled;

export type CreateAgentInput = z.input<typeof createAgentSchema>;
export type UpdateAgentInput = z.input<typeof updateAgentSchema>;
/** The fields an owner can edit, in form order. */
export type AgentField = keyof typeof fields;

/** Field name → messages, ready to show next to form inputs. */
export type FieldErrors = Partial<Record<string, string[]>>;

/** Runs a schema and returns field errors in the same shape the server uses. */
export function validateAgentInput(
  schema: typeof createAgentSchema | typeof updateAgentSchema,
  input: unknown,
): { ok: true } | { ok: false; formError?: string; fieldErrors: FieldErrors } {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true };
  const { formErrors, fieldErrors } = z.flattenError(result.error);
  return { ok: false, formError: formErrors[0], fieldErrors: fieldErrors as FieldErrors };
}
