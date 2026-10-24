import "server-only";

// Structured logs: one JSON object per line, so they're easy to search and
// parse later. Fields are scalars only. That's deliberate: it makes it awkward
// to log whole objects, which is how prompts, replies, and secrets end up in logs.

export type LogLevel = "info" | "warn" | "error";
export type LogFields = Record<string, string | number | boolean | null | undefined>;
export type Logger = (level: LogLevel, event: string, fields?: LogFields) => void;

export const jsonLogger: Logger = (level, event, fields = {}) => {
  const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
};

/** Shortens free text (e.g. a provider's error string) before it is logged. */
export function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
