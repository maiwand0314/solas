import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { RelativeTime } from "@/components/ui/relative-time";
import type { StepState, WorkerFailureView, WorkerInstanceState, WorkerInstanceView, WorkerStatus } from "@/server/workers/status";
import { summarizeWorker } from "./worker-status-summary";

const STEP_LABEL = { scheduler: "Scheduler", notifications: "Notification sync", recovery: "Recovery check", queue: "Claiming work" } as const;

const STEP_STATE: Record<StepState, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  ok: { label: "Working", tone: "success" },
  starting: { label: "Starting", tone: "neutral" },
  failing: { label: "Failing", tone: "danger" },
  overdue: { label: "Overdue", tone: "warning" },
};

const INSTANCE_STATE: Record<WorkerInstanceState, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  healthy: { label: "Running", tone: "success" },
  degraded: { label: "Degraded", tone: "warning" },
  stopped: { label: "Stopped normally", tone: "neutral" },
  stale: { label: "Stopped reporting", tone: "danger" },
};

type Limits = { heartbeatSeconds: number; staleSeconds: number; overdueMinutes: number };

/**
 * Worker health in Settings (M6C): what the workers last reported, read from
 * the database. Read-only: the web app can't start or stop the worker.
 */
export function WorkerStatusPanel({ status, limits }: { status: WorkerStatus; limits: Limits }) {
  const summary = summarizeWorker(status);
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-surface px-4 py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Badge tone={summary.tone}>{summary.label}</Badge>
          {status.state !== "unavailable" && (
            <span className="text-xs text-muted">
              Checked <RelativeTime date={status.checkedAt} />
            </span>
          )}
        </div>
        <p className="mt-2 text-sm text-muted">{summary.description}</p>
      </div>

      {"instances" in status &&
        status.instances.map((instance) => <InstanceCard key={instance.id} instance={instance} />)}

      {"recentFailures" in status && status.recentFailures.length > 0 && <RecentFailures failures={status.recentFailures} />}

      <Callout title="How this is decided">
        <p>
          A running worker writes a heartbeat every {limits.heartbeatSeconds} seconds, even when it has no work. After{" "}
          {limits.staleSeconds} seconds without one, it is treated as stopped. A heartbeat alone isn’t enough to count as
          running: the scheduler, notification sync, and recovery check must also succeed, and a worker whose step fails or
          hasn’t succeeded for {limits.overdueMinutes} minutes shows as degraded.
        </p>
        <p className="mt-2">
          Solas only reads this status; it can’t start or stop the worker. Start it with <code>npm run worker</code>, or let
          macOS keep it running (see <code>docs/worker-launchd.md</code>).
        </p>
      </Callout>
    </div>
  );
}

function InstanceCard({ instance }: { instance: WorkerInstanceView }) {
  const state = INSTANCE_STATE[instance.state];
  const live = instance.state === "healthy" || instance.state === "degraded";
  return (
    <section aria-label={`Worker ${instance.hostname}, process ${instance.pid}`} className="rounded-lg border border-border px-4 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 truncate font-medium" title={instance.id}>
          {instance.hostname} <span className="font-normal text-muted">· process {instance.pid}</span>
        </p>
        <Badge tone={state.tone}>{state.label}</Badge>
      </div>
      <dl className="mt-3 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <Item label="Started">
          <RelativeTime date={instance.startedAt} />
        </Item>
        <Item label={instance.stoppedAt ? "Stopped" : "Last heartbeat"}>
          <RelativeTime date={instance.stoppedAt ?? instance.lastHeartbeatAt} />
        </Item>
        {instance.steps.map((step) => (
          <Item key={step.step} label={STEP_LABEL[step.step]}>
            {live && <Badge tone={STEP_STATE[step.state].tone}>{STEP_STATE[step.state].label}</Badge>}
            <span className={live ? "mt-1 block text-muted" : "block"}>
              {step.lastOkAt ? (
                <>
                  Last succeeded <RelativeTime date={step.lastOkAt} />
                </>
              ) : (
                "Hasn’t succeeded yet"
              )}
            </span>
            {step.state === "failing" && step.lastFailure && <span className="mt-1 block text-muted">{step.lastFailure.message}</span>}
          </Item>
        ))}
        {live && instance.queueFailure && (
          <Item label={STEP_LABEL.queue}>
            <Badge tone="danger">Failing</Badge>
            <span className="mt-1 block text-muted">{instance.queueFailure.message}</span>
          </Item>
        )}
      </dl>
    </section>
  );
}

function RecentFailures({ failures }: { failures: WorkerFailureView[] }) {
  return (
    <section aria-labelledby="worker-failures-heading">
      <h3 id="worker-failures-heading" className="text-sm font-medium">
        Recent problems
      </h3>
      <ul className="mt-2 divide-y divide-border rounded-lg border border-border text-sm">
        {failures.map((failure) => (
          <li key={failure.id} className="flex flex-col gap-1 px-4 py-2.5 sm:flex-row sm:items-baseline sm:gap-3">
            <span className="shrink-0 text-xs text-muted sm:w-20">
              <RelativeTime date={failure.occurredAt} />
            </span>
            <span className="min-w-0">
              <span className="font-medium">{STEP_LABEL[failure.step]}:</span> <span className="text-muted">{failure.message}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-subtle">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
