import type { Metadata } from "next";
import { Suspense } from "react";
import { BackLink } from "@/components/agents/back-link";
import { LoadError } from "@/components/load-error";
import { TeamForm, TeamFormSkeleton } from "@/components/teams/team-form";
import { PageHeader } from "@/components/ui/page-header";
import { listAgentsForOwner } from "@/server/agents/queries";
import { loadTeam } from "../load-team";

export const metadata: Metadata = {
  title: "Edit team",
};

export default function EditTeamPage({ params }: PageProps<"/teams/[teamId]/edit">) {
  return (
    <Suspense fallback={<TeamFormSkeleton />}>
      <EditTeamContent params={params} />
    </Suspense>
  );
}

async function EditTeamContent({ params }: Pick<PageProps<"/teams/[teamId]/edit">, "params">) {
  const { teamId } = await params;
  const result = await loadTeam(teamId);
  if ("error" in result) return <LoadError error={result.error} subject="teams" />;
  const { team, members } = result.detail;
  const agents = await listAgentsForOwner();
  return (
    <>
      <BackLink href={`/teams/${team.id}`}>{team.name}</BackLink>
      <PageHeader title={`Edit ${team.name}`} description="Changes are saved when you select Save changes." />
      {/* key: a fresh form whenever the saved team changes. */}
      <TeamForm
        key={`${team.id}:${team.updatedAt.toISOString()}`}
        mode="edit"
        agents={agents.map(({ id, name, role, enabled }) => ({ id, name, role, enabled }))}
        team={{
          id: team.id,
          name: team.name,
          description: team.description,
          memberIds: members.map((member) => member.id),
          coordinatorId: members.find((member) => member.teamRole === "coordinator")?.id ?? "",
        }}
      />
    </>
  );
}
