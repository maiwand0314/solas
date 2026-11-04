import Link from "next/link";
import type { ReactNode } from "react";
import { PencilIcon } from "@/components/icons";
import { LiveRefresh } from "@/components/live-refresh";
import { TaskStatusBadge } from "@/components/tasks/task-status-badge";
import { Badge } from "@/components/ui/badge";
import { buttonClassName } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { RelativeTime } from "@/components/ui/relative-time";
import { isActiveTaskStatus } from "@/lib/tasks/status";
import type { TeamDetail as TeamDetailData, TeamMemberView } from "@/server/teams/service";
import { DeleteTeamButton } from "./delete-team-dialog";
import { TeamDelegation } from "./team-delegation";

const READINESS: Record<TeamMemberView["readiness"], { label: string; tone: "success" | "neutral" | "warning" }> = {
  ready: { label: "Enabled", tone: "success" },
  disabled: { label: "Disabled", tone: "neutral" },
  unconfigured: { label: "No model", tone: "warning" },
};

/**
 * One team, from the database: who is in it, what each member can do, who
 * may delegate to whom, the team's tasks, and recent activity on them.
 */
export function TeamDetail({ detail }: { detail: TeamDetailData }) {
  const { team, members, tasks, taskCount, activity } = detail;
  const active = tasks.some((task) => isActiveTaskStatus(task.status));
  const coordinator = members.find((member) => member.teamRole === "coordinator");

  return (
    <>
      <LiveRefresh active={active} intervalMs={3_000} />
      <PageHeader
        title={team.name}
        description={team.description || undefined}
        actions={
          <Link href={`/teams/${team.id}/edit`} className={buttonClassName({ variant: "secondary" })}>
            <PencilIcon className="size-4" />
            Edit
          </Link>
        }
      />

      <div className="divide-y divide-border">
        <Section
          title="Members"
          description={coordinator ? `${coordinator.name} coordinates.` : "No coordinator yet."}
        >
          {members.length === 0 ? (
            <p className="text-muted">
              No members yet. <Link href={`/teams/${team.id}/edit`} className="text-foreground underline underline-offset-2">Add agents</Link>.
            </p>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
              {members.map((member) => (
                <li key={member.id} className="px-4 py-3.5">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <Link href={`/agents/${member.id}`} className="font-medium underline-offset-2 hover:underline">
                      {member.name}
                    </Link>
                    {member.teamRole === "coordinator" && <Badge tone="active">Coordinator</Badge>}
                    <Badge tone={READINESS[member.readiness].tone}>{READINESS[member.readiness].label}</Badge>
                    {member.agentRole && <span className="text-sm text-muted">{member.agentRole}</span>}
                  </div>
                  <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-subtle">
                    <span>{member.modelLabel ?? "No model"}</span>
                    <span>{member.tools.length > 0 ? `Tools: ${member.tools.join(", ")}` : "No tools"}</span>
                    <span>
                      {member.delegatesTo.length > 0
                        ? `Delegates to ${member.delegatesTo.map((target) => target.name).join(", ")}`
                        : "Doesn’t delegate"}
                    </span>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          title="Delegation"
          description="Who may hand a subtask to whom. Being in the team, or coordinating it, grants nothing by itself."
        >
          <TeamDelegation teamId={team.id} members={members} />
          <p className="mt-2 text-sm text-muted">
            Solas checks these permissions on every delegation. Each task may delegate once, and a delegated task
            can’t delegate again.
          </p>
        </Section>

        <Section
          title="Tasks"
          description={`${taskCount} ${taskCount === 1 ? "task" : "tasks"} given to this team.`}
        >
          {tasks.length === 0 ? (
            <p className="text-muted">
              No tasks yet. Choose this team when you create a task, and it shows up here.
            </p>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
              {tasks.map((task) => (
                <li key={task.id} className="relative flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-surface-hover/60">
                  <Link
                    href={`/tasks/${task.id}`}
                    className="min-w-0 basis-full truncate font-medium after:absolute after:inset-0 after:content-[''] sm:flex-1 sm:basis-auto"
                  >
                    {task.title}
                  </Link>
                  <span className="text-sm text-muted">
                    {task.agentName}
                    {task.parentTaskId && <span className="text-subtle"> · delegated</span>}
                  </span>
                  <TaskStatusBadge status={task.status} cancelling={task.cancelRequestedAt !== null} />
                  <span className="text-xs text-subtle tabular-nums">
                    <RelativeTime date={task.updatedAt} />
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href={`/tasks/new?team=${team.id}`} className={buttonClassName({ size: "sm" })}>
              New task for this team
            </Link>
            {taskCount > 0 && (
              <Link href={`/tasks?team=${team.id}`} className={buttonClassName({ size: "sm", variant: "ghost" })}>
                All team tasks
              </Link>
            )}
          </div>
        </Section>

        <Section title="Recent activity" description="The latest events on this team’s tasks.">
          {activity.length === 0 ? (
            <p className="text-muted">Nothing has happened on this team’s tasks yet.</p>
          ) : (
            <ol aria-label="Team activity" className="flex flex-col gap-3">
              {activity.map((event) => (
                <li key={event.id} className="text-sm">
                  <p className="break-words">{event.message}</p>
                  <p className="mt-0.5 text-xs text-subtle">
                    <Link href={`/tasks/${event.taskId}`} className="underline-offset-2 hover:underline">
                      {event.taskTitle}
                    </Link>{" "}
                    · {event.agentName} · <RelativeTime date={event.createdAt} />
                  </p>
                </li>
              ))}
            </ol>
          )}
        </Section>

        <Section title="Delete">
          <div className="flex flex-col items-start gap-3 rounded-lg border border-border bg-surface px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted">Delete the team. Its agents, tasks, and history stay.</p>
            <DeleteTeamButton team={{ id: team.id, name: team.name }} />
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
