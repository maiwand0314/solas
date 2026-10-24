"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CopyIcon, PencilIcon } from "@/components/icons";
import { Button, buttonClassName } from "@/components/ui/button";
import { DeleteAgentDialog } from "./delete-agent-dialog";
import { useAgentCommands } from "./use-agent-commands";

type AgentRef = { id: string; name: string };

/** Header actions on the details page: Duplicate and Edit. */
export function AgentHeaderActions({ agent }: { agent: AgentRef }) {
  const { pending, duplicate } = useAgentCommands();
  return (
    <>
      <Button onClick={() => duplicate(agent)} disabled={pending}>
        <CopyIcon className="size-4" />
        {pending ? "Duplicating…" : "Duplicate"}
      </Button>
      <Link href={`/agents/${agent.id}/edit`} className={buttonClassName({ variant: "primary" })}>
        <PencilIcon className="size-4" />
        Edit
      </Link>
    </>
  );
}

/** The delete area at the bottom of the details page. */
export function DeleteAgentSection({ agent }: { agent: AgentRef }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-border bg-surface px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-muted">Permanently delete this agent and its configuration.</p>
      <Button variant="danger-outline" onClick={() => setOpen(true)}>
        Delete agent…
      </Button>
      <DeleteAgentDialog
        agent={agent}
        open={open}
        onOpenChange={setOpen}
        onDeleted={() => router.replace("/agents")}
      />
    </div>
  );
}
