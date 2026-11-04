import type { Metadata } from "next";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import { AgentListSkeleton } from "@/components/agents/agent-skeletons";
import { PlusIcon, TeamsIcon } from "@/components/icons";
import { LoadError } from "@/components/load-error";
import { TeamList } from "@/components/teams/team-list";
import { buttonClassName } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { listAgentsForOwner } from "@/server/agents/queries";
import { listTeamsForOwner } from "@/server/teams/queries";

export const metadata: Metadata = {
  title: "Teams",
};

function NewTeamButton() {
  return (
    <Link href="/teams/new" className={buttonClassName({ variant: "primary" })}>
      <PlusIcon className="size-4" />
      New team
    </Link>
  );
}

export default function TeamsPage() {
  return (
    <>
      <PageHeader
        title="Teams"
        description="Groups of agents that work together, with a coordinator and the delegation between them."
        actions={<NewTeamButton />}
      />
      <Suspense fallback={<AgentListSkeleton />}>
        <StoredTeams />
      </Suspense>
    </>
  );
}

async function StoredTeams() {
  let teams;
  let agents;
  try {
    [teams, agents] = await Promise.all([listTeamsForOwner(), listAgentsForOwner()]);
  } catch (error) {
    unstable_rethrow(error);
    return <LoadError error={error} subject="teams" />;
  }
  if (teams.length === 0) {
    return (
      <EmptyState
        icon={TeamsIcon}
        title="No teams yet"
        description="Create a team from your agents, choose a coordinator, and decide who may delegate to whom."
      >
        <NewTeamButton />
      </EmptyState>
    );
  }
  return <TeamList teams={teams} agents={agents.map(({ id, name }) => ({ id, name }))} />;
}
