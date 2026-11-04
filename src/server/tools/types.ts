import type { z } from "zod";

// The contract every Solas tool fulfils. A tool exists only if it is written
// in backend code and registered in registry.ts; nothing an agent writes in
// its instructions or replies can create, change, or enable one.

export type ToolRisk = "low" | "medium" | "high";

/**
 * "optional": the owner chooses, per agent, between running automatically and
 * asking first. "required": every call waits for the owner's approval.
 */
export type ApprovalPolicy = "optional" | "required";

/** What a tool may touch, shown to the owner in plain words. */
export type ToolCapability = "none" | "workspace-read";

/** What a running tool gets from Solas. Nothing else is in scope. */
export type ToolContext = {
  /** The agent's own workspace directory (absolute). Tools never go outside it. */
  workspaceDir: string;
  /** Aborted on Stop, timeout, or when the tool's own time limit is reached. */
  signal: AbortSignal;
};

/** A safe failure: the message is written for the model and the owner. */
export class ToolError extends Error {
  readonly name = "ToolError";
}

export type ToolDefinition<Input extends z.ZodObject = z.ZodObject, Output extends z.ZodType = z.ZodType> = {
  /** Unique and stable; also the name the model sees. Letters, digits, and "_". */
  id: string;
  /** Short label for the UI. */
  name: string;
  /** What it does, for the model and for the owner. */
  description: string;
  input: Input;
  /** The result contract: checked before anything goes back to the model. */
  output: Output;
  risk: ToolRisk;
  approval: ApprovalPolicy;
  capability: ToolCapability;
  /**
   * Whether running it changes anything (files, messages, other services).
   * Solas never repeats an attempt automatically once such a call may have
   * run: the change could happen twice. Read-only tools are false.
   */
  sideEffects: boolean;
  /** The mode a newly enabled tool starts in. */
  defaultMode: "allow" | "ask";
  timeoutMs: number;
  /** The result sent to the model is cut to this many characters. */
  maxOutputChars: number;
  /** A one-line summary of the input, for the activity log. */
  summarizeInput(input: z.output<Input>): string;
  /** A one-line summary of the result, for the activity log. */
  summarizeOutput(output: z.output<Output>): string;
  execute(input: z.output<Input>, context: ToolContext): Promise<z.output<Output>>;
};

/** A tool definition with its generics erased, for the registry and the invoker. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any, any>;

/** Plain data about a tool for the browser: no handler, no schema. */
export type ToolCatalogEntry = {
  id: string;
  name: string;
  description: string;
  risk: ToolRisk;
  approval: ApprovalPolicy;
  capability: ToolCapability;
  defaultMode: "allow" | "ask";
};
