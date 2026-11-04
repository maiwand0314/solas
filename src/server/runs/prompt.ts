/**
 * What Solas tells every agent about where it runs, ahead of the owner's
 * instructions. Claude Code always adds an "Environment" section (working
 * directory, git status, platform). For a Solas agent that directory is an
 * empty sandbox, and without this note the model offered to read the owner's
 * project files and cited the sandbox as a source. Everything here is true:
 * the agent has exactly the tools listed, and nothing else.
 */
export function runtimeNote(toolNames: string[], place: RunPlace = "conversation"): string {
  const intro = "You are an agent in Solas, the owner's private workspace for AI agents.";
  const tools =
    toolNames.length === 0
      ? `In this ${place} you have no tools: you cannot read or write files, run commands, or open web pages.`
      : `In this ${place} you can use only these tools: ${toolNames.join(", ")}. You cannot run commands, ` +
        "write files, or open web pages. File tools only see your own workspace folder; give paths relative to it.";
  const environment =
    "Any environment details you see (working directory, git status, platform) describe an empty sandbox, not the " +
    "user's project or your workspace, so don't mention them unless the user asks.";
  return `${intro} ${tools} ${environment}\n\nThe owner's instructions for you follow.`;
}

/** Where a run happens: answering in a conversation, or working on a task. */
export type RunPlace = "conversation" | "task";

/** The system prompt for a run: the runtime note, then the agent's saved instructions unchanged. */
export function buildSystemPrompt(instructions: string, toolNames: string[] = [], place: RunPlace = "conversation"): string {
  return `${runtimeNote(toolNames, place)}\n\n${instructions}`;
}

/**
 * The prompt for one attempt at a task. A task has no conversation: the owner
 * isn't there to answer questions, so the agent is asked to finish the work
 * in one go and state its assumptions.
 */
export function buildTaskPrompt(title: string, instructions: string): string {
  return [
    `Task: ${title}`,
    "",
    instructions,
    "",
    "Work on this task now and reply with the finished result. The owner can’t answer questions while you " +
      "work, so make reasonable assumptions and state them briefly.",
  ].join("\n");
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
