import Link from "next/link";
import type { ReactNode } from "react";
import { ToolActivity, type ToolInfo } from "@/components/conversations/tool-activity";
import { Markdown } from "@/components/conversations/markdown";
import { LiveRefresh } from "@/components/live-refresh";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { PageHeader } from "@/components/ui/page-header";
import { RelativeTime } from "@/components/ui/relative-time";
import { cn } from "@/lib/cn";
import { isActiveTaskStatus } from "@/lib/tasks/status";
import type { TaskAttempt, TaskDetail as TaskDetailData, TaskEventView } from "@/server/tasks/service";
import { TaskActions } from "./task-actions";
import { TaskApprovals } from "./task-approvals";
import { TaskStatusBadge } from "./task-status-badge";

const ATTEMPT_STATUS: Record<TaskAttempt["status"], { label: string; tone: "neutral" | "active" | "success" | "danger" }> = {
  pending: { label: "Waiting", tone: "neutral" },
  running: { label: "Running", tone: "active" },
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

/** Event types drawn with a colored dot on the timeline; the rest are neutral. */
const EVENT_TONE: Partial<Record<TaskEventView["type"], string>> = {
  completed: "bg-success",
  tool_succeeded: "bg-success",
  failed: "bg-danger",
  tool_failed: "bg-danger",
  tool_denied: "bg-danger",
  approval_requested: "bg-warning",
  interrupted: "bg-warning",
  retry_scheduled: "bg-warning",
  claimed: "bg-accent",
  started: "bg-accent",
};

const fullDateTime = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" });

/**
 * One task: its real status, result, instructions, attempts, and timeline,
 * all read from PostgreSQL. While the task is active the page re-renders
 * from the database every second (LiveRefresh); nothing is simulated.
 */
export function TaskDetail({ detail, toolInfo }: { detail: TaskDetailData; toolInfo: ToolInfo }) {
  const { task, agent, attempts, events, toolCalls } = detail;
  const active = isActiveTaskStatus(task.status);
  const cancelling = task.cancelRequestedAt !== null && active;
  const current = attempts.at(-1);
  // Waiting calls get approval cards at the top; the activity list shows the rest.
  const waiting = toolCalls.filter((call) => call.status === "awaiting_approval");
  const decided = toolCalls.filter((call) => call.status !== "awaiting_approval");

  return (
    <>
      <LiveRefresh active={active} />
      <PageHeader
        title={task.title}
        badge={<TaskStatusBadge status={task.status} cancelling={cancelling} />}
        description={
          <>
            Assigned to{" "}
            <Link href={`/agents/${agent.id}`} className="text-foreground underline-offset-2 hover:underline">
              {agent.name}
            </Link>{" "}
            · Created <RelativeTime date={task.createdAt} />
          </>
        }
        actions={<TaskActions taskId={task.id} title={task.title} status={task.status} cancelling={cancelling} />}
      />

      <TaskApprovals calls={waiting} toolInfo={toolInfo} agentName={agent.name} />
      <StatusNotice detail={detail} current={current} cancelling={cancelling} />

      <div className="divide-y divide-border">
        {task.result !== null ? (
          <Section title="Result" description={task.finishedAt ? <>Saved <RelativeTime date={task.finishedAt} /></> : undefined}>
            <div className="rounded-lg border border-border bg-surface px-4 py-3.5 text-reading break-words">
              <Markdown>{task.result}</Markdown>
            </div>
          </Section>
        ) : current?.status === "running" && current.partialOutput ? (
          <Section title="Written so far" description="Not saved until the attempt completes.">
            <div aria-live="polite" className="rounded-lg border border-dashed border-border-strong px-4 py-3.5 text-reading break-words text-muted">
              <Markdown>{current.partialOutput}</Markdown>
            </div>
          </Section>
        ) : null}

        <Section title="Instructions">
          <div className="rounded-lg border border-border bg-surface px-4 py-3.5 text-reading break-words whitespace-pre-wrap">
            {task.instructions}
          </div>
        </Section>

        {decided.length > 0 && (
          <Section title="Tool activity" description="Every call, checked against the agent’s permissions.">
            <ToolActivity calls={decided} toolInfo={toolInfo} agentName={agent.name} now={null} />
          </Section>
        )}

        <Section title="Attempts" description="Each try at the task, newest last.">
          <ol className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
            {attempts.map((attempt) => (
              <AttemptRow key={attempt.id} attempt={attempt} />
            ))}
          </ol>
        </Section>

        <Section title="Timeline" description="What happened, as recorded.">
          <ol aria-label="Task events" className="flex flex-col">
            {events.map((event, index) => (
              <li key={event.id} className="relative flex gap-3 pb-4 last:pb-0">
                {/* The line linking one event to the next. */}
                {index < events.length - 1 && (
                  <span aria-hidden="true" className="absolute top-3.5 bottom-0 left-[3px] w-px bg-border" />
                )}
                <span
                  aria-hidden="true"
                  className={cn("relative mt-1.5 size-[7px] shrink-0 rounded-full", EVENT_TONE[event.type] ?? "bg-subtle")}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm break-words">{event.message}</p>
                  <p className="mt-0.5 text-xs text-subtle tabular-nums" title={`${fullDateTime.format(event.createdAt)} UTC`}>
                    <RelativeTime date={event.createdAt} />
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </Section>
      </div>
    </>
  );
}

/** One line under the header saying what is happening now, in plain words. */
function StatusNotice({
  detail,
  current,
  cancelling,
}: {
  detail: TaskDetailData;
  current: TaskAttempt | undefined;
  cancelling: boolean;
}) {
  const { task, agent } = detail;
  const attempt = current ? ` · attempt ${current.attempt}` : "";
  let notice: ReactNode = null;

  if (cancelling) {
    notice = <StatusLine active>Cancelling. Waiting for the worker to stop the attempt{attempt}.</StatusLine>;
  } else if (task.status === "queued") {
    notice = current?.notBefore ? (
      <StatusLine active>
        Retry scheduled{attempt}. It starts <RelativeTime date={current.notBefore} /> or as soon as the worker is free after that.
      </StatusLine>
    ) : (
      <div className="flex flex-col gap-1">
        <StatusLine active>Queued{attempt}. Waiting for the worker to pick it up.</StatusLine>
        <p className="pl-3.5 text-sm text-subtle">
          If it stays queued, check that the worker is running: <code>npm run worker</code>.
        </p>
      </div>
    );
  } else if (task.status === "running") {
    notice = (
      <StatusLine active>
        {agent.name} is working{attempt}
        {current?.startedAt ? (
          <>
            {" "}· started <RelativeTime date={current.startedAt} />
          </>
        ) : null}
        . You can close Solas; it keeps running.
      </StatusLine>
    );
  } else if (task.status === "awaiting_approval") {
    notice = <StatusLine active>Waiting for your approval{attempt}. The attempt’s time limit is paused.</StatusLine>;
  } else if (task.status === "failed") {
    notice = (
      <Callout tone="danger" title="Failed">
        {task.errorMessage ?? "The task failed. Check the worker log."}
      </Callout>
    );
  } else if (task.status === "interrupted") {
    notice = <Callout title="Interrupted">{task.errorMessage ?? "The attempt was interrupted."}</Callout>;
  } else if (task.status === "cancelled") {
    notice = <Callout title="Cancelled">Nothing more runs for this task. Use Retry to start a new attempt.</Callout>;
  }

  return notice ? <div className="mb-6">{notice}</div> : null;
}

function StatusLine({ children, active = false }: { children: ReactNode; active?: boolean }) {
  return (
    <p role="status" className="flex items-baseline gap-2 text-sm text-muted">
      {active && <span aria-hidden="true" className="size-1.5 shrink-0 translate-y-[-1px] rounded-full bg-accent motion-safe:animate-pulse" />}
      <span>{children}</span>
    </p>
  );
}

function AttemptRow({ attempt }: { attempt: TaskAttempt }) {
  const status = ATTEMPT_STATUS[attempt.status];
  const duration =
    attempt.startedAt && attempt.finishedAt ? formatDuration(attempt.finishedAt.getTime() - attempt.startedAt.getTime()) : null;
  const tokens =
    attempt.inputTokens !== null && attempt.outputTokens !== null
      ? `${attempt.inputTokens.toLocaleString("en")} in · ${attempt.outputTokens.toLocaleString("en")} out tokens`
      : null;
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium tabular-nums">Attempt {attempt.attempt}</span>
        <Badge tone={status.tone}>{status.label}</Badge>
        <span className="ml-auto flex flex-wrap gap-x-3 text-xs text-subtle tabular-nums">
          {attempt.startedAt ? (
            <span>
              Started <RelativeTime date={attempt.startedAt} />
            </span>
          ) : attempt.notBefore ? (
            <span>
              Not before <RelativeTime date={attempt.notBefore} />
            </span>
          ) : (
            <span>Not started</span>
          )}
          {duration && <span>Took {duration}</span>}
          {attempt.modelId && <span className="font-mono">{attempt.modelId}</span>}
          {tokens && <span>{tokens}</span>}
        </span>
      </div>
      {attempt.errorMessage && <p className="mt-1 text-sm break-words text-muted">{attempt.errorMessage}</p>}
    </li>
  );
}

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-3 py-6 first:pt-0 lg:grid-cols-[12rem_1fr] lg:gap-10">
      <div>
        <h2 className="font-semibold">{title}</h2>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} min`;
}
