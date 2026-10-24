import type { z } from "zod";

// The contract between Solas and any AI provider. The executor (and through
// it the worker) only knows these types; each provider has an adapter that
// turns them into its own SDK calls. SDK types never leave the adapter.

/**
 * A tool the agent may call in this run, as any provider sees it. Solas
 * builds these from the agent's permissions; `invoke` runs the full check
 * (permission, validation, approval, limits) every time it is called.
 */
export type RuntimeTool = {
  /** The tool's ID, also the name the model calls it by. */
  name: string;
  description: string;
  /** The input fields, as a Zod object shape (converted to JSON Schema by the adapter). */
  inputShape: z.ZodRawShape;
  invoke(input: unknown): Promise<ToolCallOutcome>;
};

/** What goes back to the model: the result, or an error it can read and react to. */
export type ToolCallOutcome = { text: string; isError: boolean };

/** What one execution needs: who the agent is, what it's asked, which model. */
export type RunInput = {
  /** The agent's stored instructions, sent as the system prompt. */
  systemPrompt: string;
  /** The user's message, with earlier turns of the conversation included. */
  prompt: string;
  /** A model ID from the provider registry, e.g. "claude-opus-5-5". */
  model: string;
  /** The only tools the model can use; empty means none at all. */
  tools: RuntimeTool[];
};

/**
 * Why a run failed, as a stable code. Messages shown to the owner are written
 * by Solas from these codes, never copied from the provider, so nothing
 * internal (paths, tokens, stack traces) can leak into the UI.
 */
export type RunErrorCode =
  | "not_signed_in"
  | "account_not_allowed"
  | "billing_problem"
  | "usage_limit"
  | "provider_unavailable"
  | "model_unavailable"
  | "paid_credential_refused"
  | "unsafe_configuration"
  | "response_too_long"
  | "budget_exceeded"
  | "provider_error"
  | "runtime_unavailable";

export type RunUsage = { inputTokens: number; outputTokens: number };

export type RunResult =
  | { status: "completed"; text: string; usage: RunUsage }
  | { status: "failed"; code: RunErrorCode; message: string; retryAt?: Date }
  /** The signal was aborted; the caller knows whether that was a timeout or Stop. */
  | { status: "aborted" };

/** Called with the reply written so far, each time the provider sends more of it. */
export type OnProgress = (textSoFar: string) => void;

export interface AgentRuntime {
  /** Matches the provider ID in the registry, e.g. "claude-agent-sdk". */
  readonly providerId: string;
  /**
   * Runs one execution to the end. Never throws: every outcome is a RunResult.
   * `onProgress` receives real partial text as it arrives (if the provider
   * streams); the final text is always the one in the result.
   */
  run(input: RunInput, signal: AbortSignal, onProgress?: OnProgress): Promise<RunResult>;
}
