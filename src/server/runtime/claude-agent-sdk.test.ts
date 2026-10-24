import type { HookCallback, Options, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "@/server/logger";
import { buildRuntimeEnv, createClaudeAgentSdkRuntime } from "./claude-agent-sdk";
import type { RunInput } from "./types";

// Unit tests with a fake SDK: no Claude Code process starts, no usage is spent.
// Each test scripts the messages Claude Code would send and checks what Solas
// makes of them.

const input: RunInput = {
  systemPrompt: "You are a careful research assistant.",
  prompt: "Explain supervised learning.",
  model: "claude-opus-5-5",
};

const init = {
  type: "system",
  subtype: "init",
  apiKeySource: "none",
  tools: [],
  mcp_servers: [],
  permissionMode: "dontAsk",
  model: "claude-opus-5-5",
};

const success = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Supervised learning uses labelled examples.",
  usage: { input_tokens: 120, output_tokens: 45 },
};

/** A fake `query` that yields the given messages and records its arguments. */
function fakeQuery(script: unknown[] | ((options: Options) => AsyncGenerator<unknown>)) {
  const calls: { prompt: unknown; options: Options }[] = [];
  const close = vi.fn();
  const query = ((params: { prompt: unknown; options: Options }) => {
    calls.push(params);
    const messages =
      typeof script === "function"
        ? script(params.options)
        : (async function* () {
            yield* script;
          })();
    return Object.assign(messages, { close });
  }) as unknown as typeof sdkQuery;
  return { query, calls, close };
}

const silentLog: Logger = () => {};

function runtimeWith(query: typeof sdkQuery, log: Logger = silentLog) {
  return createClaudeAgentSdkRuntime({ workDir: "/tmp/solas-runtime-test", maxBudgetUsd: 1, log, query });
}

describe("query options", () => {
  it("sends the agent's stored instructions, the prompt, and the model unchanged", async () => {
    const { query, calls } = fakeQuery([init, success]);
    await runtimeWith(query).run(input, new AbortController().signal);

    expect(calls[0].prompt).toBe(input.prompt);
    expect(calls[0].options.systemPrompt).toBe(input.systemPrompt);
    expect(calls[0].options.model).toBe("claude-opus-5-5");
  });

  it("enables no tools, no settings, no MCP servers, and never bypasses permissions", async () => {
    const { query, calls } = fakeQuery([init, success]);
    await runtimeWith(query).run(input, new AbortController().signal);
    const options = calls[0].options;

    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual([]);
    expect(options.permissionMode).toBe("dontAsk");
    expect(options.permissionMode).not.toBe("bypassPermissions");
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.mcpServers).toEqual({});
    expect(options.persistSession).toBe(false);
    expect(options.maxTurns).toBe(1);
    expect(options.cwd).toBe("/tmp/solas-runtime-test");
  });

  it("installs a hook that denies any tool call", async () => {
    const { query, calls } = fakeQuery([init, success]);
    await runtimeWith(query).run(input, new AbortController().signal);
    const hook = calls[0].options.hooks?.PreToolUse?.[0].hooks[0] as HookCallback;

    const decision = await hook(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } } as never,
      "tool-1",
      { signal: new AbortController().signal },
    );
    expect(decision).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });
});

describe("buildRuntimeEnv", () => {
  it("passes only an allowlist, so secrets and paid credentials never reach Claude", () => {
    const env = buildRuntimeEnv({
      PATH: "/usr/bin",
      HOME: "/Users/owner",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      ANTHROPIC_AUTH_TOKEN: "token",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
      CLAUDE_CODE_USE_BEDROCK: "1",
      ANTHROPIC_BASE_URL: "https://proxy.example",
      DATABASE_URL: "postgres://solas:password@127.0.0.1/solas",
      POSTGRES_PASSWORD: "password",
    });

    expect(env).toMatchObject({ PATH: "/usr/bin", HOME: "/Users/owner", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
    const serialized = JSON.stringify(env);
    for (const secret of ["sk-ant-secret", "token", "oauth", "proxy.example", "password", "BEDROCK"]) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describe("outcomes", () => {
  it("returns Claude's real answer and token usage", async () => {
    const { query } = fakeQuery([init, success]);
    expect(await runtimeWith(query).run(input, new AbortController().signal)).toEqual({
      status: "completed",
      text: "Supervised learning uses labelled examples.",
      usage: { inputTokens: 120, outputTokens: 45 },
    });
  });

  it("refuses to continue when Claude would use an API key instead of the subscription", async () => {
    const { query, close } = fakeQuery([{ ...init, apiKeySource: "ANTHROPIC_API_KEY" }, success]);
    const result = await runtimeWith(query).run(input, new AbortController().signal);

    expect(result).toMatchObject({ status: "failed", code: "paid_credential_refused" });
    expect(close).toHaveBeenCalled();
  });

  it("refuses a session that started with tools or MCP servers", async () => {
    const { query } = fakeQuery([{ ...init, tools: ["Bash", "Read"] }, success]);
    expect(await runtimeWith(query).run(input, new AbortController().signal)).toMatchObject({
      status: "failed",
      code: "unsafe_configuration",
    });
  });

  it("refuses a session that started a different model than the agent's", async () => {
    const { query } = fakeQuery([{ ...init, model: "claude-haiku-5-5" }, success]);
    expect(await runtimeWith(query).run(input, new AbortController().signal)).toMatchObject({
      status: "failed",
      code: "model_unavailable",
    });
  });

  it("reports a missing sign-in with the command that fixes it", async () => {
    const { query } = fakeQuery([
      init,
      { type: "assistant", error: "authentication_failed", message: { content: [] } },
      { ...success, is_error: true, result: "" },
    ]);
    const result = await runtimeWith(query).run(input, new AbortController().signal);
    expect(result).toMatchObject({ status: "failed", code: "not_signed_in" });
    expect(result.status === "failed" && result.message).toContain("claude auth login");
  });

  it("stops at a rejected usage limit and says when it resets", async () => {
    const resetsAt = Math.floor(Date.UTC(2026, 9, 24, 18) / 1000);
    const { query } = fakeQuery([init, { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt } }]);
    const result = await runtimeWith(query).run(input, new AbortController().signal);

    expect(result).toMatchObject({ status: "failed", code: "usage_limit" });
    expect(result.status === "failed" && result.retryAt?.toISOString()).toBe("2026-10-24T18:00:00.000Z");
  });

  it("stops instead of continuing on paid extra usage", async () => {
    const { query } = fakeQuery([
      init,
      { type: "rate_limit_event", rate_limit_info: { status: "allowed", isUsingOverage: true } },
      success,
    ]);
    const result = await runtimeWith(query).run(input, new AbortController().signal);
    expect(result).toMatchObject({ status: "failed", code: "usage_limit" });
    expect(result.status === "failed" && result.message).toContain("extra usage");
  });

  it("maps the per-run budget cap", async () => {
    const { query } = fakeQuery([init, { type: "result", subtype: "error_max_budget_usd", is_error: true, errors: [] }]);
    expect(await runtimeWith(query).run(input, new AbortController().signal)).toMatchObject({
      code: "budget_exceeded",
    });
  });

  it("never shows provider error text to the owner, only logs a shortened copy", async () => {
    const log = vi.fn<Logger>();
    const { query } = fakeQuery(async function* () {
      yield init;
      throw new Error("spawn failed with token sk-ant-secret-123");
    });
    const result = await runtimeWith(query, log).run(input, new AbortController().signal);

    expect(result).toMatchObject({ status: "failed", code: "runtime_unavailable" });
    expect(JSON.stringify(result)).not.toContain("sk-ant-secret");
    expect(log).toHaveBeenCalledWith("error", "runtime.crashed", expect.any(Object));
  });
});

describe("cancellation", () => {
  it("returns aborted when the signal fires mid-run, and closes the session", async () => {
    const controller = new AbortController();
    const { query, close } = fakeQuery(async function* (options) {
      yield init;
      controller.abort();
      // The real SDK rejects once its abort controller fires.
      if (options.abortController?.signal.aborted) throw new Error("aborted");
      yield success;
    });

    expect(await runtimeWith(query).run(input, controller.signal)).toEqual({ status: "aborted" });
    expect(close).toHaveBeenCalled();
  });

  it("doesn't start Claude at all when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { query, calls } = fakeQuery([init, success]);

    expect(await runtimeWith(query).run(input, controller.signal)).toEqual({ status: "aborted" });
    expect(calls).toHaveLength(0);
  });
});
