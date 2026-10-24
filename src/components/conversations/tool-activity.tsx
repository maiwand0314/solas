"use client";

import { useState, useTransition } from "react";
import { decideToolCall } from "@/app/(app)/conversations/actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { ToolCallView } from "@/server/conversations/service";
import type { ToolCallStatus } from "@/server/db/schema";
import type { ToolRisk } from "@/server/tools/types";

/** What the view knows about each tool: its name and risk. */
export type ToolInfo = Record<string, { name: string; risk: ToolRisk }>;

const STATUS: Record<ToolCallStatus, { label: string; tone: "neutral" | "active" | "success" | "danger" | "warning" }> = {
  awaiting_approval: { label: "Waiting for your approval", tone: "warning" },
  approved: { label: "Approved", tone: "active" },
  running: { label: "Running", tone: "active" },
  succeeded: { label: "Done", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  rejected: { label: "Rejected by you", tone: "neutral" },
  expired: { label: "Approval expired", tone: "neutral" },
  denied: { label: "Not permitted", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

const DOT: Record<(typeof STATUS)[ToolCallStatus]["tone"], string> = {
  neutral: "bg-subtle",
  active: "bg-accent motion-safe:animate-pulse",
  success: "bg-success",
  danger: "bg-danger",
  warning: "bg-warning",
};

type ToolActivityProps = {
  calls: ToolCallView[];
  toolInfo: ToolInfo;
  agentName: string;
  now: number | null;
  /** Finished runs show their tools folded away, behind a summary line. */
  collapsed?: boolean;
};

/**
 * The tool calls of one run, as recorded by the worker: what was called,
 * with what, and what came of it. Calls waiting for approval get a card with
 * the exact input and Approve / Reject.
 */
export function ToolActivity({ calls, toolInfo, agentName, now, collapsed = false }: ToolActivityProps) {
  if (calls.length === 0) return null;
  const list = (
    <ul className="flex flex-col gap-2">
      {calls.map((call) =>
        call.status === "awaiting_approval" ? (
          <li key={call.id}>
            <ApprovalCard call={call} toolInfo={toolInfo} agentName={agentName} now={now} />
          </li>
        ) : (
          <li key={call.id}>
            <ToolCallLine call={call} toolInfo={toolInfo} />
          </li>
        ),
      )}
    </ul>
  );
  if (!collapsed) return <div aria-label="Tool activity">{list}</div>;
  return (
    <details className="group text-sm">
      <summary className="inline-flex cursor-pointer items-center gap-1.5 rounded-sm text-subtle hover:text-foreground">
        <span aria-hidden="true" className="transition-transform duration-100 group-open:rotate-90">
          ›
        </span>
        Used {calls.length} {calls.length === 1 ? "tool" : "tools"}
      </summary>
      <div className="mt-2">{list}</div>
    </details>
  );
}

function ToolCallLine({ call, toolInfo }: { call: ToolCallView; toolInfo: ToolInfo }) {
  const status = STATUS[call.status];
  const detail = call.errorMessage ?? call.resultSummary;
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", DOT[status.tone])} />
        <span className="font-medium">{toolInfo[call.toolId]?.name ?? call.toolId}</span>
        <span className="min-w-0 truncate font-mono text-xs text-muted">{call.inputSummary}</span>
        <span className="ml-auto text-xs text-subtle">{status.label}</span>
      </div>
      {detail && (
        <p className={cn("mt-1 pl-3.5 text-xs break-words", call.errorMessage ? "text-danger" : "text-muted")}>
          {detail}
        </p>
      )}
    </div>
  );
}

function ApprovalCard({
  call,
  toolInfo,
  agentName,
  now,
}: {
  call: ToolCallView;
  toolInfo: ToolInfo;
  agentName: string;
  now: number | null;
}) {
  const [pending, startTransition] = useTransition();
  const [decided, setDecided] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const info = toolInfo[call.toolId];
  const name = info?.name ?? call.toolId;
  const secondsLeft =
    now !== null && call.approvalExpiresAt
      ? Math.max(0, Math.floor((new Date(call.approvalExpiresAt).getTime() - now) / 1000))
      : null;

  function decide(decision: "approve" | "reject") {
    if (pending || decided) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await decideToolCall(call.id, decision);
        if (result.ok) setDecided(decision);
        else setError(result.error.message);
      } catch {
        setError("Couldn’t reach Solas. Try again.");
      }
    });
  }

  return (
    <section
      aria-label={`Approval needed: ${name}`}
      className="rounded-lg border border-warning/50 bg-warning/[0.07] px-4 py-3.5"
    >
      <p className="font-medium">
        {agentName} wants to use {name}
      </p>
      <p className="mt-0.5 text-sm text-muted">
        {info ? `${info.risk[0].toUpperCase()}${info.risk.slice(1)} risk. ` : ""}
        It runs only if you approve, and only with exactly this input:
      </p>
      <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs leading-5">
        {JSON.stringify(call.input, null, 2)}
      </pre>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" onClick={() => decide("approve")} disabled={pending || decided !== null}>
          {decided === "approve" ? "Approved" : "Approve"}
        </Button>
        <Button size="sm" onClick={() => decide("reject")} disabled={pending || decided !== null}>
          {decided === "reject" ? "Rejected" : "Reject"}
        </Button>
        {secondsLeft !== null && decided === null && (
          <span className="ml-auto text-xs text-subtle tabular-nums">
            Expires in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")}
          </span>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
