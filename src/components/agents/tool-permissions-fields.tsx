"use client";

import { useId } from "react";
import { AlertIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { AgentToolSetting } from "@/lib/agents/validation";
import type { ToolCatalogEntry, ToolRisk } from "@/server/tools/types";

type ToolPermissionsFieldsProps = {
  catalog: ToolCatalogEntry[];
  /** Enabled tools only, in catalog order. */
  value: AgentToolSetting[];
  onChange: (next: AgentToolSetting[]) => void;
  error?: string;
  /** Focus target for errors (the form moves focus here). */
  errorId: string;
  workspacePath: string;
};

const RISK: Record<ToolRisk, { label: string; tone: "neutral" | "warning" | "danger" }> = {
  low: { label: "Low risk", tone: "neutral" },
  medium: { label: "Medium risk", tone: "warning" },
  high: { label: "High risk", tone: "danger" },
};

/**
 * One row per tool Solas has: a switch to enable it and, when the owner
 * chooses, whether it runs automatically or asks first. What's saved is
 * checked again by the server and enforced by the worker on every call.
 */
export function ToolPermissionsFields({ catalog, value, onChange, error, errorId, workspacePath }: ToolPermissionsFieldsProps) {
  const baseId = useId();
  const usesWorkspace = value.some(
    (setting) => catalog.find((tool) => tool.id === setting.toolId)?.capability === "workspace-read",
  );

  function setTool(tool: ToolCatalogEntry, mode: "allow" | "ask" | "off") {
    const others = value.filter((setting) => setting.toolId !== tool.id);
    const next = mode === "off" ? others : [...others, { toolId: tool.id, mode }];
    // Keep catalog order, so an unchanged selection compares equal.
    onChange(catalog.flatMap((entry) => next.filter((setting) => setting.toolId === entry.id)));
  }

  return (
    <fieldset id={errorId} tabIndex={-1} aria-describedby={error ? `${errorId}-error` : undefined} className="focus:outline-none">
      <legend className="sr-only">Tools</legend>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
        {catalog.map((tool) => {
          const setting = value.find((entry) => entry.toolId === tool.id);
          const nameId = `${baseId}-${tool.id}-name`;
          const descriptionId = `${baseId}-${tool.id}-description`;
          const modeId = `${baseId}-${tool.id}-mode`;
          return (
            <li key={tool.id} className="px-4 py-3.5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span id={nameId} className="font-medium">
                      {tool.name}
                    </span>
                    <Badge tone={RISK[tool.risk].tone}>{RISK[tool.risk].label}</Badge>
                  </p>
                  <p id={descriptionId} className="mt-1 text-sm text-muted">
                    {tool.description}
                  </p>
                </div>
                <Switch
                  checked={Boolean(setting)}
                  onCheckedChange={(checked) => setTool(tool, checked ? tool.defaultMode : "off")}
                  aria-labelledby={nameId}
                  aria-describedby={descriptionId}
                  className="mt-0.5"
                />
              </div>
              {setting &&
                (tool.approval === "required" ? (
                  <p className="mt-3 text-sm text-muted">Always asks for your approval before it runs.</p>
                ) : (
                  <div className="mt-3 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
                    <label htmlFor={modeId} className="text-sm text-muted">
                      When the agent uses it
                    </label>
                    <div className="sm:w-56">
                      <Select
                        id={modeId}
                        value={setting.mode}
                        onChange={(event) => setTool(tool, event.target.value as "allow" | "ask")}
                      >
                        <option value="allow">Run automatically</option>
                        <option value="ask">Ask me first</option>
                      </Select>
                    </div>
                  </div>
                ))}
            </li>
          );
        })}
      </ul>
      {usesWorkspace && (
        <p className="mt-2 text-sm text-muted">
          File tools only see this agent’s workspace folder, read-only:{" "}
          <code className="font-mono text-[0.8125rem] break-all text-foreground">{workspacePath}</code>. Put files there
          for the agent to read.
        </p>
      )}
      {error && (
        <p id={`${errorId}-error`} className="mt-2 flex items-start gap-1.5 text-sm text-danger">
          <AlertIcon className="mt-0.5 size-3.5 shrink-0" />
          {error}
        </p>
      )}
    </fieldset>
  );
}
