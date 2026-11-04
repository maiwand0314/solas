"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { deleteAutomation, runAutomationNow, setAutomationEnabled } from "@/app/(app)/automations/actions";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Dialog } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";

type Target = { id: string; name: string };

/** Pause or resume. Resuming counts the next run from now: nothing missed while paused is caught up. */
export function PauseResumeButton({ automation, enabled }: { automation: Target; enabled: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function toggle() {
    if (pending) return;
    startTransition(async () => {
      try {
        const result = await setAutomationEnabled(automation.id, !enabled);
        if (!result.ok) {
          toast.error(result.error.message);
          return;
        }
        toast.success(enabled ? `Paused “${automation.name}”.` : `Resumed “${automation.name}”.`);
        router.refresh();
      } catch {
        toast.error("Couldn’t reach Solas. Try again.");
      }
    });
  }

  return (
    <Button onClick={toggle} disabled={pending}>
      {pending ? (enabled ? "Pausing…" : "Resuming…") : enabled ? "Pause" : "Resume"}
    </Button>
  );
}

/**
 * "Run now…" with a confirmation, because every run is a real Claude run on
 * the owner's plan. Uses the same safeguards as a scheduled run.
 */
export function RunNowButton({ automation, agentName, variant = "secondary" }: {
  automation: Target;
  agentName: string;
  variant?: "primary" | "secondary";
}) {
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

  function confirmRun() {
    if (pending) return;
    startTransition(async () => {
      try {
        const result = await runAutomationNow(automation.id);
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        setOpen(false);
        toast.success(`Started a run of “${automation.name}”. It appears in the history.`);
        router.refresh();
      } catch {
        setError("Couldn’t reach Solas. Try again.");
      }
    });
  }

  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}>
        Run now…
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
            Run “{automation.name}” now?
          </h2>
          <p id={descriptionId} className="mt-2 text-muted">
            This creates a task for {agentName} right away, as one Claude run on your plan. The schedule doesn’t
            change.
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
          <Button variant="primary" onClick={confirmRun} disabled={pending}>
            {pending ? "Starting…" : "Run now"}
          </Button>
        </div>
      </Dialog>
    </>
  );
}

/**
 * "Delete automation…" with a confirmation. Focus starts on Cancel. Says
 * what goes (the automation and its run history) and what stays (its tasks).
 */
export function DeleteAutomationButton({ automation }: { automation: Target }) {
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
        const result = await deleteAutomation(automation.id);
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        setOpen(false);
        toast.success(`Deleted “${automation.name}”.`);
        router.replace("/automations");
      } catch {
        setError("Couldn’t reach Solas. Try again.");
      }
    });
  }

  return (
    <>
      <Button variant="danger-outline" onClick={() => setOpen(true)}>
        Delete automation…
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
            Delete “{automation.name}”?
          </h2>
          <p id={descriptionId} className="mt-2 text-muted">
            This deletes the automation, its schedule, and its run history. The tasks it created stay, with their
            results. A run that is in progress isn’t stopped; cancel it from its task. It can’t be undone.
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
            {pending ? "Deleting…" : "Delete automation"}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
