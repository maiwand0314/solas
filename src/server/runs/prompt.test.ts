import { describe, expect, it } from "vitest";
import { buildPrompt, type HistoryMessage } from "./prompt";

const limits = { historyMessages: 20, historyCharacters: 1_000 };

describe("buildPrompt", () => {
  it("sends the message as-is when there is no history", () => {
    expect(buildPrompt([], "Hello", limits)).toBe("Hello");
  });

  it("includes earlier turns, oldest first, before the new message", () => {
    const prompt = buildPrompt(
      [
        { role: "user", content: "What is ML?" },
        { role: "assistant", content: "Machine learning is…" },
      ],
      "Give an example.",
      limits,
    );
    expect(prompt.indexOf("<user>\nWhat is ML?")).toBeLessThan(prompt.indexOf("<assistant>\nMachine learning"));
    expect(prompt.endsWith("Give an example.")).toBe(true);
  });

  it("drops the oldest messages first when the history is too long", () => {
    const history: HistoryMessage[] = [
      { role: "user", content: "old ".repeat(200) },
      { role: "assistant", content: "recent answer" },
    ];
    const prompt = buildPrompt(history, "Next?", { historyMessages: 20, historyCharacters: 100 });
    expect(prompt).toContain("recent answer");
    expect(prompt).not.toContain("old old");
  });

  it("keeps at most the configured number of messages", () => {
    const history: HistoryMessage[] = Array.from({ length: 5 }, (_, index) => ({
      role: "user" as const,
      content: `message ${index}`,
    }));
    const prompt = buildPrompt(history, "Now", { historyMessages: 2, historyCharacters: 1_000 });
    expect(prompt).not.toContain("message 2");
    expect(prompt).toContain("message 3");
    expect(prompt).toContain("message 4");
  });
});
