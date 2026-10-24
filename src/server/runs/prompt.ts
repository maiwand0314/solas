/**
 * What Solas tells every agent about where it runs, ahead of the owner's
 * instructions. Claude Code always adds an "Environment" section (working
 * directory, git status, platform). For a Solas agent that directory is an
 * empty sandbox, and without this note the model offered to read the owner's
 * project files and cited the sandbox as a source. Everything here is true:
 * the agent has no tools in this milestone.
 */
export const RUNTIME_NOTE =
  "You are an agent in Solas, the owner's private workspace for AI agents. In this conversation you have no tools: " +
  "you cannot read or write files, run commands, or open web pages. Any environment details you see (working " +
  "directory, git status, platform) describe an empty sandbox, not the user's project, so don't mention them " +
  "unless the user asks.\n\nThe owner's instructions for you follow.";

/** The system prompt for a run: the runtime note, then the agent's saved instructions unchanged. */
export function buildSystemPrompt(instructions: string): string {
  return `${RUNTIME_NOTE}\n\n${instructions}`;
}

// Builds the text Claude receives for one run. Each run is a fresh Claude
// session (Solas doesn't use SDK session resume), so earlier turns are included
// as a transcript. Only the newest messages fit; the oldest are dropped first.

export type HistoryMessage = { role: "user" | "assistant"; content: string };

export function buildPrompt(
  earlier: HistoryMessage[],
  latest: string,
  limits: { historyMessages: number; historyCharacters: number },
): string {
  const kept: HistoryMessage[] = [];
  let characters = 0;
  for (const message of earlier.slice(-limits.historyMessages).reverse()) {
    if (characters + message.content.length > limits.historyCharacters) break;
    kept.unshift(message);
    characters += message.content.length;
  }
  if (kept.length === 0) return latest;

  return [
    "Earlier messages in this conversation, oldest first:",
    "",
    ...kept.map((message) => `<${message.role}>\n${message.content}\n</${message.role}>`),
    "",
    "Reply to the user’s new message:",
    "",
    latest,
  ].join("\n");
}
