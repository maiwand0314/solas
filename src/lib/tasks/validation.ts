import { z } from "zod";

// Input rules for tasks, shared by the New task form (instant feedback) and
// the server (which checks again, because the browser can't be trusted).

export const TASK_LIMITS = {
  title: 120,
  instructions: 20_000,
} as const;

export const taskTitleSchema = z
  .string({ error: "Title must be text." })
  .trim()
  .min(1, { error: "Give the task a title." })
  .max(TASK_LIMITS.title, { error: `Titles can be at most ${TASK_LIMITS.title} characters.` });

export const taskInstructionsSchema = z
  .string({ error: "Instructions must be text." })
  .trim()
  .min(1, { error: "Describe what the agent should do." })
  .max(TASK_LIMITS.instructions, {
    error: `Instructions can be at most ${TASK_LIMITS.instructions.toLocaleString("en")} characters.`,
  });

/**
 * Creating a task. `clientRequestId` makes a repeated submit (a double click,
 * or a retry after a dropped connection) return the first task instead of
 * creating a second one.
 */
export const createTaskSchema = z.strictObject({
  agentId: z.uuid({ error: "Choose an agent." }),
  title: taskTitleSchema,
  instructions: taskInstructionsSchema,
  clientRequestId: z.uuid({ error: "Invalid request ID." }).optional(),
  /** Optional (M5B): the team this task is for. The agent must be a member. */
  teamId: z.uuid({ error: "Choose a team from the list." }).nullable().optional(),
});

export type CreateTaskInput = z.input<typeof createTaskSchema>;
