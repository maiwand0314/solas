import "server-only";
import { currentTimeTool } from "./builtin/current-time";
import { listWorkspaceFilesTool, readWorkspaceFileTool } from "./builtin/workspace-files";
import type { AnyToolDefinition, ToolCatalogEntry } from "./types";

// The tool registry: the complete list of tools Solas can run. To add a tool,
// write a ToolDefinition in builtin/ and add it here. Nothing else registers
// tools, and an agent can only use tools listed here that its owner enabled.

export type ToolRegistry = {
  list(): readonly AnyToolDefinition[];
  get(id: string): AnyToolDefinition | undefined;
  /** Plain data for the browser (no handlers, no schemas). */
  catalog(): ToolCatalogEntry[];
};

const TOOL_ID = /^[a-z][a-z0-9_]{1,63}$/;

export function createToolRegistry(tools: readonly AnyToolDefinition[]): ToolRegistry {
  const byId = new Map<string, AnyToolDefinition>();
  for (const tool of tools) {
    if (!TOOL_ID.test(tool.id)) throw new Error(`Invalid tool ID “${tool.id}”.`);
    if (byId.has(tool.id)) throw new Error(`Tool ID “${tool.id}” is registered twice.`);
    if (tool.approval === "required" && tool.defaultMode !== "ask") {
      throw new Error(`Tool “${tool.id}” requires approval, so its default mode must be "ask".`);
    }
    byId.set(tool.id, tool);
  }
  return {
    list: () => tools,
    get: (id) => byId.get(id),
    catalog: () =>
      tools.map(({ id, name, description, risk, approval, capability, defaultMode }) => ({
        id,
        name,
        description,
        risk,
        approval,
        capability,
        defaultMode,
      })),
  };
}

export const toolRegistry = createToolRegistry([currentTimeTool, listWorkspaceFilesTool, readWorkspaceFileTool]);
