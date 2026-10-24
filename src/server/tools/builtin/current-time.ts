import "server-only";
import { z } from "zod";
import { ToolError, type ToolDefinition } from "../types";

const input = z.strictObject({
  timeZone: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional()
    .describe('An IANA time zone such as "Europe/Oslo". Defaults to the server\'s time zone.'),
});

const output = z.strictObject({
  iso: z.string(),
  timeZone: z.string(),
  local: z.string(),
});

/** The server's current date and time, optionally in a given time zone. */
export const currentTimeTool: ToolDefinition<typeof input, typeof output> = {
  id: "current_time",
  name: "Current date and time",
  description: "Returns the current date and time, in a given IANA time zone or the server's own.",
  input,
  output,
  risk: "low",
  approval: "optional",
  capability: "none",
  defaultMode: "allow",
  timeoutMs: 2_000,
  maxOutputChars: 500,
  summarizeInput: ({ timeZone }) => timeZone ?? "server time zone",
  summarizeOutput: ({ local, timeZone }) => `${local} (${timeZone})`,
  async execute({ timeZone }) {
    const now = new Date();
    let formatter: Intl.DateTimeFormat;
    try {
      formatter = new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeStyle: "long", timeZone });
    } catch {
      throw new ToolError(`“${timeZone}” isn’t a known time zone. Use an IANA name such as “Europe/Oslo”.`);
    }
    return { iso: now.toISOString(), timeZone: formatter.resolvedOptions().timeZone, local: formatter.format(now) };
  },
};
