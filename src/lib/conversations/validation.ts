import { z } from "zod";

// Input rules for chat messages, shared by the composer (instant feedback) and
// the server (which checks again, because the browser can't be trusted).

export const MESSAGE_MAX_LENGTH = 20_000;

export const messageContentSchema = z
  .string({ error: "Message must be text." })
  .trim()
  .min(1, { error: "Write a message first." })
  .max(MESSAGE_MAX_LENGTH, {
    error: `Messages can be at most ${MESSAGE_MAX_LENGTH.toLocaleString("en")} characters.`,
  });

/**
 * Sending a message either continues a conversation or starts a new one with
 * an agent: exactly one of the two IDs is given.
 */
export const sendMessageSchema = z
  .strictObject({
    conversationId: z.uuid({ error: "Invalid conversation." }).optional(),
    agentId: z.uuid({ error: "Invalid agent." }).optional(),
    content: messageContentSchema,
  })
  .refine((input) => (input.conversationId === undefined) !== (input.agentId === undefined), {
    error: "Send to either a conversation or an agent.",
  });

export type SendMessageInput = z.input<typeof sendMessageSchema>;
