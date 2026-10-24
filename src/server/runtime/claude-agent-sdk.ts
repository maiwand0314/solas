import "server-only";
import {
  query as sdkQuery,
  type HookCallback,
  type Options,
  type SDKAssistantMessageError,
  type SDKMessage,
  type SDKRateLimitInfo,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { truncate, type Logger } from "@/server/logger";
import type { AgentRuntime, OnProgress, RunErrorCode, RunInput, RunResult } from "./types";

// The Claude adapter. It runs the official Claude Agent SDK, which starts the
// unmodified Claude Code binary bundled with it. That binary signs in with the
// owner's own Claude login on this Mac; Solas never sees or handles a credential.
//
// Everything Claude Code can do beyond answering is switched off here and then
// checked again when the session starts (see verifySession). This milestone is
// conversation only: no tools, no files, no shell, no MCP servers.

export const CLAUDE_PROVIDER_ID = "claude-agent-sdk";

/**
 * Variables copied from the worker's environment into the Claude process.
 * An allowlist, not a blocklist: DATABASE_URL, passwords, and any
 * ANTHROPIC_* / CLAUDE_CODE_USE_* variable that could switch Claude to a paid
 * API key or another provider are never passed on.
 */
const INHERITED_ENV = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR"] as const;

export function buildRuntimeEnv(source: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const value = source[name];
    if (value) env[name] = value;
  }
  return {
    ...env,
    // Don't load or write Claude Code's per-directory memory files.
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    // Don't connect the owner's claude.ai connectors (Gmail, Drive, …).
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    // Identifies Solas honestly in the User-Agent header.
    CLAUDE_AGENT_SDK_CLIENT_APP: "solas/0.1.0",
  };
}

/** A hook that refuses every tool call. Hooks run first and hold in every mode. */
const denyAllTools: HookCallback = async () => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "Tools are disabled for Solas agents.",
  },
});

export function buildQueryOptions(
  input: RunInput,
  settings: { workDir: string; maxBudgetUsd: number; abortController: AbortController; stderr: (data: string) => void },
): Options {
  return {
    model: input.model,
    // A plain string replaces Claude Code's own system prompt entirely, so the
    // agent is exactly what its stored instructions say.
    systemPrompt: input.systemPrompt,
    // An empty directory outside the repository; nothing for the agent to find.
    cwd: settings.workDir,
    env: buildRuntimeEnv(process.env),
    // No built-in tools at all, nothing pre-approved, and anything else is
    // denied without asking. Never "bypassPermissions".
    tools: [],
    allowedTools: [],
    permissionMode: "dontAsk",
    hooks: { PreToolUse: [{ hooks: [denyAllTools] }] },
    // Ignore the owner's ~/.claude settings, CLAUDE.md, skills, and plugins,
    // and every MCP server except the (empty) list given here.
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    // Don't write session transcripts to ~/.claude/projects. Solas keeps its
    // own history in PostgreSQL.
    persistSession: false,
    // Stream text as Claude writes it (real deltas from the API).
    includePartialMessages: true,
    // One answer, no tool round trips.
    maxTurns: 1,
    // A safety cap on Claude Code's own cost estimate for a single run.
    maxBudgetUsd: settings.maxBudgetUsd,
    abortController: settings.abortController,
    stderr: settings.stderr,
  };
}

type Dependencies = {
  workDir: string;
  maxBudgetUsd: number;
  log: Logger;
  /** The SDK's query function; tests pass a fake. */
  query?: typeof sdkQuery;
};

export function createClaudeAgentSdkRuntime({ workDir, maxBudgetUsd, log, query = sdkQuery }: Dependencies): AgentRuntime {
  async function run(input: RunInput, signal: AbortSignal, onProgress?: OnProgress): Promise<RunResult> {
    if (signal.aborted) return { status: "aborted" };

    const abortController = new AbortController();
    const onAbort = () => abortController.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });

    // Keep the end of stderr for the log if Claude Code fails to start.
    let stderrTail = "";
    const stderr = (data: string) => {
      stderrTail = (stderrTail + data).slice(-2000);
    };

    const session = query({
      prompt: input.prompt,
      options: buildQueryOptions(input, { workDir, maxBudgetUsd, abortController, stderr }),
    });

    let assistantError: SDKAssistantMessageError | undefined;
    let rateLimit: SDKRateLimitInfo | undefined;
    let result: SDKResultMessage | undefined;
    let textSoFar = "";

    try {
      for await (const message of session) {
        if (message.type === "system" && message.subtype === "init") {
          const problem = verifySession(message, input.model);
          // An audit line for every session: how Claude actually started.
          log("info", "runtime.session_started", {
            apiKeySource: message.apiKeySource,
            model: message.model,
            tools: message.tools.length,
            mcpServers: message.mcp_servers.length,
            permissionMode: message.permissionMode,
            claudeCodeVersion: message.claude_code_version,
          });
          if (problem) {
            log("error", "runtime.session_refused", { code: problem.code, detail: problem.detail });
            return { status: "failed", code: problem.code, message: problem.message };
          }
        } else if (message.type === "rate_limit_event") {
          rateLimit = message.rate_limit_info;
          if (rateLimit.status === "rejected" || usesPaidOverage(rateLimit)) {
            // Stop at once: rejected means no more usage, and overage means
            // the next tokens would be billed as extra usage.
            log("warn", "runtime.usage_limit", {
              status: rateLimit.status,
              limitType: rateLimit.rateLimitType,
              overage: usesPaidOverage(rateLimit),
            });
            return usageLimitFailure(rateLimit);
          }
          if (rateLimit.status === "allowed_warning") {
            log("warn", "runtime.usage_warning", { limitType: rateLimit.rateLimitType, utilization: rateLimit.utilization });
          }
        } else if (message.type === "stream_event") {
          // Only the visible reply text; thinking and other blocks are skipped.
          const event = message.event;
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            textSoFar += event.delta.text;
            onProgress?.(textSoFar);
          }
        } else if (message.type === "assistant" && message.error) {
          assistantError = message.error;
        } else if (message.type === "result") {
          result = message;
        }
      }
    } catch (error) {
      if (abortController.signal.aborted) return { status: "aborted" };
      log("error", "runtime.crashed", {
        error: truncate(error instanceof Error ? error.message : String(error)),
        stderr: truncate(stderrTail, 500),
      });
      return failure("runtime_unavailable");
    } finally {
      signal.removeEventListener("abort", onAbort);
      session.close();
    }

    if (abortController.signal.aborted) return { status: "aborted" };
    return interpretResult(result, assistantError, input.model, log);
  }

  return { providerId: CLAUDE_PROVIDER_ID, run };
}

type SessionProblem = { code: RunErrorCode; message: string; detail: string };

/**
 * Checks the session Claude Code actually started, before any answer is used.
 * Settings can come from places Solas doesn't control (managed policies, a
 * Console login), so Solas verifies the result instead of trusting its options.
 */
export function verifySession(
  init: Extract<SDKMessage, { type: "system"; subtype: "init" }>,
  requestedModel: string,
): SessionProblem | null {
  // "none" means no API key is in play: requests use the subscription login.
  if (init.apiKeySource !== "none") {
    return {
      code: "paid_credential_refused",
      message: MESSAGES.paid_credential_refused,
      detail: `apiKeySource=${init.apiKeySource}`,
    };
  }
  if (init.tools.length > 0 || init.mcp_servers.length > 0 || init.permissionMode !== "dontAsk") {
    return {
      code: "unsafe_configuration",
      message: MESSAGES.unsafe_configuration,
      detail: `tools=${init.tools.length} mcp=${init.mcp_servers.length} mode=${init.permissionMode}`,
    };
  }
  if (init.model !== requestedModel) {
    return {
      code: "model_unavailable",
      message: `Claude started with a different model than “${requestedModel}”, so the run was stopped.`,
      detail: `model=${init.model}`,
    };
  }
  return null;
}

function usesPaidOverage(info: SDKRateLimitInfo): boolean {
  return info.isUsingOverage === true || info.overageInUse === true || info.rateLimitType === "overage";
}

function usageLimitFailure(info: SDKRateLimitInfo): RunResult {
  const retryAt = info.resetsAt ? toDate(info.resetsAt) : undefined;
  const message = usesPaidOverage(info)
    ? "Your plan’s included Claude usage is used up, and continuing would use paid extra usage. Solas stopped instead. Try again after your limit resets."
    : MESSAGES.usage_limit;
  return { status: "failed", code: "usage_limit", message, retryAt };
}

/** resetsAt is a Unix time; accept seconds or milliseconds. */
function toDate(unixTime: number): Date {
  return new Date(unixTime < 1e12 ? unixTime * 1000 : unixTime);
}

function interpretResult(
  result: SDKResultMessage | undefined,
  assistantError: SDKAssistantMessageError | undefined,
  model: string,
  log: Logger,
): RunResult {
  if (result?.subtype === "success" && !result.is_error && !assistantError) {
    if (result.result.trim() === "") return failure("provider_error");
    return {
      status: "completed",
      text: result.result,
      usage: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens },
    };
  }

  if (assistantError) {
    const code = ASSISTANT_ERRORS[assistantError];
    log("warn", "runtime.provider_error", { assistantError, code });
    if (code === "model_unavailable") {
      return { status: "failed", code, message: `The model “${model}” isn’t available to your Claude account. Choose another model for this agent.` };
    }
    return failure(code);
  }

  if (result?.subtype === "error_max_budget_usd") return failure("budget_exceeded");
  log("warn", "runtime.no_result", {
    subtype: result?.subtype ?? "missing",
    error: result && "errors" in result ? truncate(result.errors.join(" | ")) : undefined,
  });
  return failure("provider_error");
}

const ASSISTANT_ERRORS: Record<SDKAssistantMessageError, RunErrorCode> = {
  authentication_failed: "not_signed_in",
  verification_required: "not_signed_in",
  oauth_org_not_allowed: "account_not_allowed",
  account_on_hold: "account_not_allowed",
  billing_error: "billing_problem",
  rate_limit: "usage_limit",
  overloaded: "provider_unavailable",
  server_error: "provider_unavailable",
  model_not_found: "model_unavailable",
  max_output_tokens: "response_too_long",
  cloud_credential_error: "paid_credential_refused",
  invalid_request: "provider_error",
  unknown: "provider_error",
};

/** Owner-facing messages, written by Solas. Provider text never reaches the UI. */
const MESSAGES: Record<RunErrorCode, string> = {
  not_signed_in:
    "Claude isn’t signed in on this computer. Run `claude auth login` in a terminal, then try again.",
  account_not_allowed:
    "Your Claude account can’t be used for this right now. Your organization may not allow it, or the account is on hold.",
  billing_problem: "Claude reported a billing problem with your account. Check your plan on claude.ai.",
  usage_limit: "You’ve reached your Claude usage limit. Try again after it resets.",
  provider_unavailable: "Claude is overloaded or unavailable right now. Try again in a moment.",
  model_unavailable: "This model isn’t available to your Claude account. Choose another model for this agent.",
  paid_credential_refused:
    "Claude is set up to use an API key or another paid credential on this computer. Solas only runs on your Claude subscription login, so it stopped the run.",
  unsafe_configuration:
    "Claude started with tools or integrations Solas didn’t allow, so the run was stopped. Check the worker log.",
  response_too_long: "The reply hit Claude’s output limit and was cut off.",
  budget_exceeded: "The run reached Solas’s per-run safety budget and was stopped.",
  provider_error: "Claude couldn’t complete this request. Check the worker log for details.",
  runtime_unavailable: "Solas couldn’t start Claude. Check the worker log for details.",
};

function failure(code: RunErrorCode): RunResult {
  return { status: "failed", code, message: MESSAGES[code] };
}
