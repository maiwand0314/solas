"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { deleteTeam } from "@/app/(app)/teams/actions";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Dialog } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";

/**
 * "Delete team…" with a confirmation. Focus starts on Cancel. Says exactly
 * what goes (the team and its membership) and what stays (agents, tasks,
 * history, delegation permissions).
 */
export function DeleteTeamButton({ team }: { team: { id: string; name: string } }) {
  const router = useRouter();
  const titleId = useId();
  const descriptionId = useId();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function changeOpen(next: boolean) {
    if (pending) return;
    if (!next) setError(null);
    setOpen(next);
  }

  function confirmDelete() {
    if (pending) return;
    startTransition(async () => {
      try {
        const result = await deleteTeam(team.id);
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        setOpen(false);
        toast.success(`Deleted “${team.name}”.`);
        router.replace("/teams");
      } catch {
        setError("Couldn’t reach Solas. Try again.");
      }
    });
  }

  return (
    <>
      <Button variant="danger-outline" onClick={() => setOpen(true)}>
        Delete team…
      </Button>
      <Dialog
        open={open}
        onOpenChange={changeOpen}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="mx-auto my-auto w-[min(440px,calc(100vw-2rem))] rounded-xl border border-border bg-surface-raised shadow-popover open:animate-dialog-in"
      >
        <div className="p-5">
          <h2 id={titleId} className="text-lg font-semibold tracking-[-0.01em]">
            Delete “{team.name}”?
          </h2>
          <p id={descriptionId} className="mt-2 text-muted">
            This deletes the team and its member list. The agents, their tasks, history, and delegation permissions
            stay; the team’s tasks just stop being linked to a team. It can’t be undone.
          </p>
          {error && (
            <Callout tone="danger" role="alert" className="mt-4">
              {error}
            </Callout>
          )}
        </div>
        <div className="flex flex-col-reverse gap-2 border-t border-border px-5 py-3 sm:flex-row sm:justify-end">
          <Button autoFocus onClick={() => changeOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={confirmDelete} disabled={pending}>
            {pending ? "Deleting…" : "Delete team"}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
