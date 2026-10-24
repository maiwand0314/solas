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
 * an agent. When both IDs are given, the server checks that the conversation
 * belongs to that agent. `clientMessageId` makes a repeated send (a retry
 * after a dropped connection) return the first result instead of a duplicate.
 */
export const sendMessageSchema = z
  .strictObject({
    conversationId: z.uuid({ error: "Invalid conversation." }).optional(),
    agentId: z.uuid({ error: "Invalid agent." }).optional(),
    clientMessageId: z.uuid({ error: "Invalid message ID." }).optional(),
    content: messageContentSchema,
  })
  .refine((input) => input.conversationId !== undefined || input.agentId !== undefined, {
    error: "Send to a conversation or an agent.",
  });

export type SendMessageInput = z.input<typeof sendMessageSchema>;

export const TITLE_MAX_LENGTH = 120;

export const conversationTitleSchema = z
  .string({ error: "Title must be text." })
  .trim()
  .min(1, { error: "Title can’t be empty." })
  .max(TITLE_MAX_LENGTH, { error: `Titles can be at most ${TITLE_MAX_LENGTH} characters.` });
