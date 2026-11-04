import type { Metadata } from "next";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import { BackLink } from "@/components/agents/back-link";
import { AgentsIcon } from "@/components/icons";
import { LoadError } from "@/components/load-error";
import { TaskForm, type TaskAgentOption, type TaskTeamOption } from "@/components/tasks/task-form";
import { buttonClassName } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { getAgentToolsForOwner, listAgentsForOwner } from "@/server/agents/queries";
import { describeModelSelection, getAgentReadiness, providerRegistry } from "@/server/providers/registry";
import { listTeamOptionsForOwner } from "@/server/teams/queries";
import { toolRegistry } from "@/server/tools/registry";

export const metadata: Metadata = {
  title: "New task",
};

export default function NewTaskPage({ searchParams }: PageProps<"/tasks/new">) {
  return (
    <>
      <BackLink href="/tasks">Tasks</BackLink>
      <PageHeader
        title="New task"
        description="Choose an agent and describe the work. The worker runs it in the background."
      />
      <Suspense fallback={<TaskFormSkeleton />}>
        <NewTaskForm searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function NewTaskForm({ searchParams }: Pick<PageProps<"/tasks/new">, "searchParams">) {
  const { team: requestedTeam } = await searchParams;
  let options: TaskAgentOption[];
  let teams: TaskTeamOption[];
  let hidden: number;
  try {
    const [agents, teamOptions] = await Promise.all([listAgentsForOwner(), listTeamOptionsForOwner()]);
    // Only agents that can run now: enabled, with an available model.
    const ready = agents.filter((agent) => getAgentReadiness(agent, providerRegistry).state === "ready");
    hidden = agents.length - ready.length;
    // Teams with at least one member who can take a task now.
    teams = teamOptions
      .map((team) => ({ ...team, memberIds: team.memberIds.filter((id) => ready.some((agent) => agent.id === id)) }))
      .filter((team) => team.memberIds.length > 0);
    options = await Promise.all(
      ready.map(async (agent) => ({
        id: agent.id,
        name: agent.name,
        role: agent.role,
        modelLabel: describeModelSelection(providerRegistry, agent) ?? "",
        tools: (await getAgentToolsForOwner(agent.id)).map((setting) => {
          const name = toolRegistry.get(setting.toolId)?.name ?? setting.toolId;
          return setting.mode === "ask" ? `${name} (asks first)` : name;
        }),
      })),
    );
  } catch (error) {
    unstable_rethrow(error);
    return <LoadError error={error} />;
  }

  if (options.length === 0) {
    return (
      <EmptyState
        icon={AgentsIcon}
        title="No agent can take tasks yet"
        description={
          hidden > 0
            ? "Your agents are disabled or have no model. Enable one and choose a model, then come back."
            : "Create an agent with instructions and a model first."
        }
      >
        <Link href={hidden > 0 ? "/agents" : "/agents/new"} className={buttonClassName({ variant: "primary" })}>
          {hidden > 0 ? "Open agents" : "New agent"}
        </Link>
      </EmptyState>
    );
  }

  return (
    <>
      <TaskForm
        agents={options}
        teams={teams}
        initialTeamId={typeof requestedTeam === "string" ? requestedTeam : undefined}
      />
      {hidden > 0 && (
        <p className="mt-4 max-w-2xl text-sm text-subtle">
          {hidden === 1
            ? "One agent isn’t listed because it is disabled or has no model."
            : `${hidden} agents aren’t listed because they are disabled or have no model.`}
        </p>
      )}
    </>
  );
}

function TaskFormSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex max-w-2xl flex-col gap-6">
      <span className="sr-only">Loading…</span>
      {[8, 8, 40].map((height, index) => (
        <div key={index}>
          <Skeleton className="mb-2 h-4 w-24" />
          <Skeleton className={height === 8 ? "h-8 w-full" : "h-40 w-full"} />
        </div>
      ))}
    </div>
  );
}
