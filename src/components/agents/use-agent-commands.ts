"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { duplicateAgent, setAgentEnabled } from "@/app/(app)/agents/actions";
import { toast } from "@/components/ui/toast";

type AgentRef = { id: string; name: string };

/**
 * Duplicate and enable/disable, shared by the list's actions menu and the
 * details page. `pending` lets callers block a second click while one runs.
 */
export function useAgentCommands() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function duplicate(agent: AgentRef) {
    if (pending) return;
    startTransition(async () => {
      const result = await duplicateAgent(agent.id);
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      toast.success(`Created “${result.data.name}”. Copies start disabled.`);
      router.push(`/agents/${result.data.id}`);
    });
  }

  function setEnabled(agent: AgentRef, enabled: boolean) {
    if (pending) return;
    startTransition(async () => {
      const result = await setAgentEnabled(agent.id, enabled);
      if (result.ok) toast.success(`${enabled ? "Enabled" : "Disabled"} “${agent.name}”.`);
      else toast.error(result.error.message);
    });
  }

  return { pending, duplicate, setEnabled };
}
