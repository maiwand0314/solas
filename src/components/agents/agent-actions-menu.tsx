"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CopyIcon, OpenIcon, PencilIcon, PowerIcon, TrashIcon } from "@/components/icons";
import { Menu } from "@/components/ui/menu";
import { DeleteAgentDialog } from "./delete-agent-dialog";
import { useAgentCommands } from "./use-agent-commands";

type AgentActionsMenuProps = {
  agent: { id: string; name: string; enabled: boolean };
};

/** The "⋯" menu on each agent in the list. */
export function AgentActionsMenu({ agent }: AgentActionsMenuProps) {
  const router = useRouter();
  const { pending, duplicate, setEnabled } = useAgentCommands();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <>
      <Menu
        label={`Actions for ${agent.name}`}
        items={[
          { label: "Open", icon: OpenIcon, onSelect: () => router.push(`/agents/${agent.id}`) },
          { label: "Edit", icon: PencilIcon, onSelect: () => router.push(`/agents/${agent.id}/edit`) },
          { label: "Duplicate", icon: CopyIcon, onSelect: () => duplicate(agent), disabled: pending },
          {
            label: agent.enabled ? "Disable" : "Enable",
            icon: PowerIcon,
            onSelect: () => setEnabled(agent, !agent.enabled),
            disabled: pending,
          },
          {
            label: "Delete…",
            icon: TrashIcon,
            tone: "danger",
            separated: true,
            onSelect: () => setConfirmingDelete(true),
          },
        ]}
      />
      <DeleteAgentDialog agent={agent} open={confirmingDelete} onOpenChange={setConfirmingDelete} />
    </>
  );
}
