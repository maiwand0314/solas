"use client";

import { useId, useState, useTransition } from "react";
import { deleteAgent } from "@/app/(app)/agents/actions";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Dialog } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";

type DeleteAgentDialogProps = {
  agent: { id: string; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after the agent is gone, e.g. to leave its details page. */
  onDeleted?: () => void;
};

/**
 * Confirms a permanent delete. Focus starts on Cancel (the safe choice), the
 * Delete button can't be pressed twice, and errors keep the dialog open.
 */
export function DeleteAgentDialog({ agent, open, onOpenChange, onDeleted }: DeleteAgentDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function changeOpen(next: boolean) {
    if (pending) return; // don't close mid-request
    if (!next) setError(null);
    onOpenChange(next);
  }

  function confirmDelete() {
    if (pending) return;
    startTransition(async () => {
      const result = await deleteAgent(agent.id);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      onOpenChange(false);
      toast.success(`Deleted “${agent.name}”.`);
      onDeleted?.();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={changeOpen}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className="mx-auto my-auto w-[min(440px,calc(100vw-2rem))] rounded-xl border border-border bg-surface-raised shadow-popover open:animate-dialog-in"
    >
      <div className="p-5">
        <h2 id={titleId} className="text-lg font-semibold tracking-[-0.01em]">
          Delete “{agent.name}”?
        </h2>
        <p id={descriptionId} className="mt-2 text-muted">
          This permanently deletes the agent and its configuration. It can’t be undone. Agents don’t
          have conversations or tasks yet, so nothing else is affected.
        </p>
        {error && (
          <Callout tone="danger" role="alert" className="mt-4">
            {error}
          </Callout>
        )}
      </div>
      <div className="flex flex-col-reverse gap-2 border-t border-border px-5 py-3 sm:flex-row sm:justify-end">
        {/* autoFocus: the dialog opens with the safe option focused. */}
        <Button autoFocus onClick={() => changeOpen(false)} disabled={pending}>
          Cancel
        </Button>
        <Button variant="danger" onClick={confirmDelete} aria-disabled={pending} disabled={pending}>
          {pending ? "Deleting…" : "Delete agent"}
        </Button>
      </div>
    </Dialog>
  );
}
