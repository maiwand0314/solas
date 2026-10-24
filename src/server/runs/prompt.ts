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
