import Link from "next/link";
import type { ReactNode } from "react";
import { Markdown } from "@/components/conversations/markdown";
import { PencilIcon } from "@/components/icons";
import { LiveRefresh } from "@/components/live-refresh";
import { buttonClassName } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { PageHeader } from "@/components/ui/page-header";
import { RelativeTime } from "@/components/ui/relative-time";
import { formatInTimeZone } from "@/lib/automations/schedule";
import type { AutomationDetail as AutomationDetailData } from "@/server/automations/service";
import { AutomationStateBadge, OccurrenceBadge } from "./automation-badges";
import { DeleteAutomationButton, PauseResumeButton, RunNowButton } from "./automation-controls";

/** Longer results are cut here; the full text is on the task's page. */
const RESULT_PREVIEW_CHARS = 4_000;

/**
 * One automation, from the database: its schedule and next runs, its
 * instructions, the latest result, and every run so far (each started run
 * opens its task). Refreshes itself while a run is in progress.
 */
export function AutomationDetail({ detail }: { detail: AutomationDetailData }) {
  const { automation, state, scheduleText, agent, upcoming, history, latestResult, hasActiveRun, counts } = detail;
  const zone = automation.timeZone;
  const target = { id: automation.id, name: automation.name };
  const missedOnce = state === "missed" ? history.find((occurrence) => occurrence.status === "missed") : undefined;

  return (
    <>
      <LiveRefresh active={hasActiveRun || state === "active"} intervalMs={hasActiveRun ? 3_000 : 15_000} />
      <PageHeader
        title={automation.name}
        description={automation.description || undefined}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href={`/automations/${automation.id}/edit`} className={buttonClassName({ variant: "secondary" })}>
              <PencilIcon className="size-4" />
              Edit
            </Link>
            {state !== "finished" && state !== "missed" && <PauseResumeButton automation={target} enabled={automation.enabled} />}
            <RunNowButton automation={target} agentName={agent.name} />
          </div>
        }
      />

      <div className="mb-6 flex flex-col gap-3 empty:hidden">
        {missedOnce && (
          <Callout
            title="The one-time run was missed"
            actions={
              <>
                <RunNowButton automation={target} agentName={agent.name} variant="primary" />
                <Link href={`/automations/${automation.id}/edit`} className={buttonClassName({ size: "sm" })}>
                  Choose a new time
                </Link>
              </>
            }
          >
            It was due at {formatInTimeZone(missedOnce.scheduledFor, zone)}, but the worker wasn’t running. A one-time
            run never starts late on its own: run it now, or choose a new time.
          </Callout>
        )}
        {agent.readiness !== "ready" && automation.enabled && (
          <Callout title={`${agent.name} can’t run tasks right now`}>
            {agent.readiness === "disabled" ? "The agent is disabled" : "The agent has no available model"}, so
            scheduled runs are skipped (and recorded below) until that’s fixed.{" "}
            <Link href={`/agents/${agent.id}/edit`} className="text-foreground underline underline-offset-2">
              Open the agent
            </Link>
          </Callout>
        )}
      </div>

      <div className="divide-y divide-border">
        <Section title="Schedule" description="Runs start as tasks in the normal queue, while the worker is running.">
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Item label="State">
              <AutomationStateBadge state={state} />
            </Item>
            <Item label="Agent">
              <Link href={`/agents/${agent.id}`} className="underline-offset-2 hover:underline">
                {agent.name}
              </Link>
            </Item>
            <Item label="Repeats">{scheduleText}</Item>
            <Item label="Time zone">{zone.replaceAll("_", " ")}</Item>
            <Item label="Next run">
              {automation.nextRunAt ? (
                <span className="tabular-nums">
                  {formatInTimeZone(automation.nextRunAt, zone)} (<RelativeTime date={automation.nextRunAt} />)
                </span>
              ) : state === "paused" ? (
                "None while paused"
              ) : (
                "None scheduled"
              )}
            </Item>
            <Item label="Last started run">
              {automation.lastRunAt ? (
                <span className="tabular-nums">{formatInTimeZone(automation.lastRunAt, zone)}</span>
              ) : (
                "Not yet"
              )}
            </Item>
          </dl>
          {upcoming.length > 1 && (
            <div className="mt-4">
              <h3 className="text-sm font-medium">Upcoming</h3>
              <ol aria-label="Upcoming runs" className="mt-1.5 flex flex-col gap-0.5 text-sm text-muted tabular-nums">
                {upcoming.map((run) => (
                  <li key={run.toISOString()}>{formatInTimeZone(run, zone)}</li>
                ))}
              </ol>
            </div>
          )}
        </Section>

        <Section title="Task instructions" description="What the agent is asked to do on every run.">
          <p className="rounded-lg border border-border bg-surface px-4 py-3 text-sm break-words whitespace-pre-wrap">
            {automation.instructions}
          </p>
        </Section>

        <Section title="Latest result" description="From the newest run that completed.">
          {latestResult ? (
            <div className="rounded-lg border border-border bg-surface px-4 py-3">
              <p className="mb-2 text-xs text-subtle">
                <Link href={`/tasks/${latestResult.taskId}`} className="underline-offset-2 hover:underline">
                  {latestResult.title}
                </Link>
                {latestResult.finishedAt && (
                  <>
                    {" "}
                    · <RelativeTime date={latestResult.finishedAt} />
                  </>
                )}
              </p>
              <Markdown>
                {latestResult.result.length > RESULT_PREVIEW_CHARS
                  ? `${latestResult.result.slice(0, RESULT_PREVIEW_CHARS)}…`
                  : latestResult.result}
              </Markdown>
              {latestResult.result.length > RESULT_PREVIEW_CHARS && (
                <Link href={`/tasks/${latestResult.taskId}`} className={buttonClassName({ size: "sm", className: "mt-3" })}>
                  Read the full result
                </Link>
              )}
            </div>
          ) : (
            <p className="text-muted">No run has completed yet.</p>
          )}
        </Section>

        <Section
          title="History"
          description={`${counts.started} started · ${counts.missed} missed · ${counts.skipped} skipped. Each started run is a task.`}
        >
          {history.length === 0 ? (
            <p className="text-muted">No runs yet. They appear here as they happen.</p>
          ) : (
            <ol aria-label="Run history" className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
              {history.map((occurrence) => (
                <li
                  key={occurrence.id}
                  className={`relative px-4 py-3 ${occurrence.task ? "hover:bg-surface-hover/60" : ""}`}
                >
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    {occurrence.task ? (
                      <Link
                        href={`/tasks/${occurrence.task.id}`}
                        className="font-medium tabular-nums after:absolute after:inset-0 after:content-['']"
                      >
                        {formatInTimeZone(occurrence.scheduledFor, zone)}
                      </Link>
                    ) : (
                      <span className="font-medium tabular-nums">{formatInTimeZone(occurrence.scheduledFor, zone)}</span>
                    )}
                    <OccurrenceBadge occurrence={occurrence} />
                    {occurrence.trigger === "manual" && <span className="text-xs text-subtle">Run now</span>}
                  </div>
                  <p className="mt-1 text-sm break-words text-muted">
                    {occurrence.task?.errorMessage ?? occurrence.message}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </Section>

        <Section title="Delete">
          <div className="flex flex-col items-start gap-3 rounded-lg border border-border bg-surface px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted">Delete the automation and its history. Its tasks stay.</p>
            <DeleteAutomationButton automation={target} />
          </div>
        </Section>
      </div>
    </>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="grid gap-3 py-6 first:pt-0 lg:grid-cols-[14rem_1fr] lg:gap-10">
      <div>
        <h2 className="font-semibold">{title}</h2>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      <div className="min-w-0">{children}</div>
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
