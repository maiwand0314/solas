"use client";

import { useId, useOptimistic, useTransition } from "react";
import { setAgentEnabled } from "@/app/(app)/agents/actions";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";

type AgentEnabledSwitchProps = {
  agent: { id: string; name: string; enabled: boolean };
};

/**
 * Turns an agent on or off, saved to the database. The switch moves at once
 * (an optimistic update); if saving fails, React puts it back and a toast
 * explains why.
 */
export function AgentEnabledSwitch({ agent }: AgentEnabledSwitchProps) {
  const descriptionId = useId();
  const [enabled, setOptimisticEnabled] = useOptimistic(agent.enabled);
  const [pending, startTransition] = useTransition();

  function change(next: boolean) {
    // aria-disabled instead of disabled, so keyboard focus stays on the switch.
    if (pending) return;
    startTransition(async () => {
      setOptimisticEnabled(next);
      const result = await setAgentEnabled(agent.id, next);
      if (result.ok) toast.success(`${next ? "Enabled" : "Disabled"} “${agent.name}”.`);
      else toast.error(result.error.message);
    });
  }

  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-surface px-4 py-3.5">
      <div className="min-w-0">
        <p aria-hidden="true" className="font-medium">
          {enabled ? "Enabled" : "Disabled"}
        </p>
        <p id={descriptionId} className="mt-0.5 text-sm text-muted">
          {enabled
            ? "You can chat with this agent in Conversations."
            : "This agent is saved but can’t answer messages. Turn it on to chat with it."}
        </p>
      </div>
      <Switch
        checked={enabled}
        onCheckedChange={change}
        // A fixed name; the on/off state is announced from aria-checked.
        aria-label="Agent enabled"
        aria-describedby={descriptionId}
        aria-disabled={pending || undefined}
        className="mt-0.5"
      />
    </div>
  );
}
