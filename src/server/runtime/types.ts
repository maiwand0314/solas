// The contract between Solas and any AI provider. The executor (and through
// it the worker) only knows these types; each provider has an adapter that
// turns them into its own SDK calls. SDK types never leave the adapter.

/** What one execution needs: who the agent is, what it's asked, which model. */
export type RunInput = {
  /** The agent's stored instructions, sent as the system prompt. */
  systemPrompt: string;
  /** The user's message, with earlier turns of the conversation included. */
  prompt: string;
  /** A model ID from the provider registry, e.g. "claude-opus-5-5". */
  model: string;
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

export interface AgentRuntime {
  /** Matches the provider ID in the registry, e.g. "claude-agent-sdk". */
  readonly providerId: string;
  /** Runs one execution to the end. Never throws: every outcome is a RunResult. */
  run(input: RunInput, signal: AbortSignal): Promise<RunResult>;
}
