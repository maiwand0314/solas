"use client";

import { useId, useOptimistic, useTransition } from "react";
import { setNotificationPreference } from "@/app/(app)/notifications/actions";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import type { NotificationKind } from "@/server/db/schema";
import type { NotificationPreference } from "@/server/notifications/preferences";

const KINDS: Record<NotificationKind, { label: string; description: string }> = {
  task_failed: { label: "Failed tasks", description: "A task that failed, after any automatic retry." },
  task_interrupted: { label: "Interrupted tasks", description: "A task whose worker stopped mid-run, when repeating it wasn’t safe." },
  automation_missed: { label: "Missed automation runs", description: "A scheduled run the worker wasn’t running for." },
  automation_skipped: { label: "Skipped automation runs", description: "A run Solas couldn’t start, e.g. because the agent or team coordinator is disabled." },
  automation_paused: { label: "Paused automations", description: "An automation Solas paused after repeated failures." },
  approval_requested: {
    label: "Approval requests",
    description: "An agent waiting for your decision. Turning this off only hides the inbox entry: the request still waits on the task or conversation.",
  },
  approval_expired: { label: "Expired approvals", description: "A request nobody answered in time, so it didn’t run." },
  approval_rejected: { label: "Rejected approvals", description: "A request that was rejected, so it didn’t run." },
};

/**
 * One switch per notification kind (M6C), saved to the database. Off stops
 * new inbox entries of that kind; turning it back on starts from that moment,
 * without replaying what happened in between. Existing notifications stay.
 */
export function NotificationPreferences({ preferences }: { preferences: NotificationPreference[] }) {
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {preferences.map((preference) => (
        <PreferenceRow key={preference.kind} preference={preference} />
      ))}
    </ul>
  );
}

function PreferenceRow({ preference }: { preference: NotificationPreference }) {
  const labelId = useId();
  const descriptionId = useId();
  const [enabled, setOptimisticEnabled] = useOptimistic(preference.enabled);
  const [pending, startTransition] = useTransition();
  const kind = KINDS[preference.kind];

  function change(next: boolean) {
    // aria-disabled instead of disabled, so keyboard focus stays on the switch.
    if (pending) return;
    startTransition(async () => {
      setOptimisticEnabled(next);
      try {
        const result = await setNotificationPreference(preference.kind, next);
        if (!result.ok) toast.error(result.error.message);
      } catch {
        toast.error("Couldn’t reach Solas. Try again.");
      }
    });
  }

  return (
    <li className="flex items-start justify-between gap-4 px-4 py-3.5">
      <div className="min-w-0">
        <p id={labelId} className="font-medium">
          {kind.label}
        </p>
        <p id={descriptionId} className="mt-0.5 text-sm text-muted">
          {kind.description}
        </p>
      </div>
      <Switch
        checked={enabled}
        onCheckedChange={change}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        aria-disabled={pending || undefined}
        className="mt-0.5"
      />
    </li>
  );
}
