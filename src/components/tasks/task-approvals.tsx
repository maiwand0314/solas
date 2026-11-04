"use client";

import { ApprovalCard, type ToolInfo } from "@/components/conversations/tool-activity";
import { useNow } from "@/components/use-now";
import type { TaskToolCall } from "@/server/tasks/service";

/**
 * Approval requests the task's running attempt is waiting on: the same card
 * as in conversations, with the exact input and Approve / Reject. The worker
 * runs the action only after Approve, with exactly that input.
 */
export function TaskApprovals({ calls, toolInfo, agentName }: { calls: TaskToolCall[]; toolInfo: ToolInfo; agentName: string }) {
  const now = useNow(calls.length > 0);
  if (calls.length === 0) return null;
  return (
    <div className="mb-6 flex flex-col gap-3">
      {calls.map((call) => (
        <ApprovalCard key={call.id} call={call} toolInfo={toolInfo} agentName={agentName} now={now} />
      ))}
    </div>
  );
}
