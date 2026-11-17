import { z } from "zod";
import { taskInstructionsSchema } from "@/lib/tasks/validation";
import { AUTOMATION_LIMITS, DEFAULT_TIME_ZONE } from "./limits";
import { intervalMs, isValidTimeZone, parseDate } from "./schedule";

// Input rules for automations, shared by the automation form (instant
// feedback) and the server (which checks again, because the browser can't be
// trusted). Rules that need the clock or the database (a one-time run in the
// past, how many automations are active) are checked by the service.

const name = z
  .string({ error: "Name must be text." })
  .trim()
  .min(1, { error: "Give the automation a name." })
  .max(AUTOMATION_LIMITS.name, { error: `Names can be at most ${AUTOMATION_LIMITS.name} characters.` });

const description = z
  .string({ error: "Description must be text." })
  .trim()
  .max(AUTOMATION_LIMITS.description, {
    error: `Descriptions can be at most ${AUTOMATION_LIMITS.description} characters.`,
  });

const time = z
  .string({ error: "Choose a time." })
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: "Choose a time, like 08:00." });

const date = z
  .string({ error: "Choose a date." })
  .regex(/^\d{4}-\d{2}-\d{2}$/, { error: "Choose a date." })
  .refine(
    (value) => {
      const { year, month, day } = parseDate(value);
      const check = new Date(Date.UTC(year, month - 1, day));
      return year >= 2000 && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
    },
    { error: "Choose a real date." },
  );

const MIN = AUTOMATION_LIMITS.minIntervalMinutes;
const MAX = AUTOMATION_LIMITS.maxIntervalMinutes;
const intervalLimitMessage =
  `Choose an interval from ${MIN >= 60 ? `${MIN / 60} ${MIN === 60 ? "hour" : "hours"}` : `${MIN} minutes`} ` +
  `to ${MAX / 60 / 24} days, to keep Claude usage reasonable.`;

export const scheduleSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({ kind: z.literal("once"), date, time }),
    z
      .strictObject({
        kind: z.literal("interval"),
        every: z.int({ error: "Enter a whole number." }).min(1, { error: "Enter a number of at least 1." }),
        unit: z.enum(["minutes", "hours"], { error: "Choose minutes or hours." }),
      })
      .refine((schedule) => intervalMs(schedule) >= MIN * 60_000 && intervalMs(schedule) <= MAX * 60_000, {
        error: intervalLimitMessage,
      }),
    z.strictObject({ kind: z.literal("daily"), time }),
    z.strictObject({
      kind: z.literal("weekly"),
      days: z
        .array(z.literal([1, 2, 3, 4, 5, 6, 7], { error: "Choose days from the list." }), { error: "Choose the days." })
        .min(1, { error: "Choose at least one day." })
        .max(7)
        .refine((days) => new Set(days).size === days.length, { error: "A day is listed twice." }),
      time,
    }),
    z.strictObject({
      kind: z.literal("monthly"),
      day: z.int({ error: "Choose a day of the month." }).min(1).max(31, { error: "Choose a day from 1 to 31." }),
      time,
    }),
  ],
  { error: "Choose when it runs." },
);

const timeZone = z
  .string({ error: "Choose a time zone." })
  .refine(isValidTimeZone, { error: "Choose a time zone from the list." });

const optionalInt = (min: number, max: number, message: string) =>
  z
    .int({ error: message })
    .min(min, { error: message })
    .max(max, { error: message })
    .nullable()
    .default(null);

/**
 * Creating or editing an automation: the form always sends every field.
 * An automation runs one agent ("agent") or a team's coordinator ("team");
 * only the chosen one is kept. The limits (M6B) can only be as strict as the
 * global AUTOMATION_LIMITS or stricter; null means "use the global limit".
 */
export const automationSchema = z
  .strictObject({
    name,
    description: description.default(""),
    targetKind: z.enum(["agent", "team"], { error: "Choose an agent or a team." }).default("agent"),
    agentId: z.uuid({ error: "Choose an agent." }).nullable().default(null),
    teamId: z.uuid({ error: "Choose a team." }).nullable().default(null),
    instructions: taskInstructionsSchema,
    schedule: scheduleSchema,
    timeZone: timeZone.default(DEFAULT_TIME_ZONE),
    enabled: z.boolean({ error: "Choose whether it is active." }).default(true),
    maxRunsPerDay: optionalInt(1, AUTOMATION_LIMITS.maxRunsPerDay, `Enter 1 to ${AUTOMATION_LIMITS.maxRunsPerDay}, or leave it empty.`),
    maxDurationMinutes: optionalInt(
      AUTOMATION_LIMITS.minDurationMs / 60_000,
      AUTOMATION_LIMITS.maxDurationMs / 60_000,
      `Enter ${AUTOMATION_LIMITS.minDurationMs / 60_000} to ${AUTOMATION_LIMITS.maxDurationMs / 60_000} minutes, or leave it empty.`,
    ),
    allowOverlap: z.boolean({ error: "Choose whether runs may overlap." }).default(false),
    pauseAfterFailures: optionalInt(1, AUTOMATION_LIMITS.maxPauseAfterFailures, `Enter 1 to ${AUTOMATION_LIMITS.maxPauseAfterFailures}, or leave it empty.`),
  })
  .superRefine((value, ctx) => {
    if (value.targetKind === "agent" && !value.agentId) ctx.addIssue({ code: "custom", path: ["agentId"], message: "Choose an agent." });
    if (value.targetKind === "team" && !value.teamId) ctx.addIssue({ code: "custom", path: ["teamId"], message: "Choose a team." });
  })
  .transform((value) => ({
    ...value,
    agentId: value.targetKind === "agent" ? value.agentId : null,
    teamId: value.targetKind === "team" ? value.teamId : null,
  }));

export type AutomationInput = z.input<typeof automationSchema>;
export type AutomationValues = z.output<typeof automationSchema>;
