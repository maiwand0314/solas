import "server-only";
import { z } from "zod";
import { DELEGATION_LIMITS } from "@/server/runs/config";
import { ToolError, type ToolDefinition } from "../types";

const input = z.strictObject({
  targetAgentId: z.uuid().describe("The ID of the agent to delegate to, from the list in this tool's description."),
  taskDescription: z
    .string()
    .trim()
    .min(20)
    .max(DELEGATION_LIMITS.maxDescriptionChars)
    .describe(
      "Everything the other agent needs to do the subtask, in your own words. It sees nothing else: not your " +
        "instructions, not the owner's task, not your files. Include the facts or findings it must use.",
    ),
  expectedOutput: z
    .string()
    .trim()
    .max(DELEGATION_LIMITS.maxExpectedOutputChars)
    .optional()
    .describe("What a good result looks like, e.g. format and length."),
});

const output = z.strictObject({
  delegationId: z.string(),
  childTaskId: z.string(),
  agentName: z.string(),
  status: z.enum(["queued", "waiting", "completed", "failed", "cancelled"]),
  message: z.string(),
  result: z.string().optional(),
});

/**
 * Hands one subtask to another Solas agent, as a new task linked to this one
 * (M5A). The tool only asks: the backend decides whether this agent may
 * delegate to that one, enforces depth and budget, and creates the child
 * task once, however often the request is repeated. The child runs later,
 * as itself (its own instructions, model, and tools); this agent gets its
 * result in a follow-up run.
 */
export const delegateToAgentTool: ToolDefinition<typeof input, typeof output> = {
  id: "delegate_to_agent",
  name: "Delegate to agent",
  description:
    "Hands one subtask to another agent as a separate task. Use it only when the owner's task calls for that " +
    "agent's help. After you delegate, end your turn with a short note of what you have done so far; Solas " +
    "gives you the other agent's result in a follow-up, and you then finish the task.",
  input,
  output,
  risk: "medium",
  approval: "optional",
  capability: "delegate",
  // Creating the child task is idempotent: a repeated request returns the same child.
  sideEffects: false,
  defaultMode: "allow",
  grantedBy: "delegation",
  timeoutMs: 10_000,
  maxOutputChars: DELEGATION_LIMITS.maxChildResultChars + 1_000,
  summarizeInput: ({ taskDescription }) => taskDescription.split("\n")[0],
  summarizeOutput: ({ agentName, status }) => `${agentName}: ${status}`,
  async execute(request, { delegate }) {
    if (!delegate) throw new ToolError("Delegation isn’t available in this run.");
    return delegate(request);
  },
};
