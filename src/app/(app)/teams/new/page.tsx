import type { Metadata } from "next";
import { unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import { BackLink } from "@/components/agents/back-link";
import { LoadError } from "@/components/load-error";
import { TeamForm, TeamFormSkeleton } from "@/components/teams/team-form";
import { PageHeader } from "@/components/ui/page-header";
import { listAgentsForOwner } from "@/server/agents/queries";

export const metadata: Metadata = {
  title: "New team",
};

export default function NewTeamPage() {
  return (
    <>
      <BackLink href="/teams">Teams</BackLink>
      <PageHeader title="New team" description="Name the team, add agents, and choose a coordinator." />
      <Suspense fallback={<TeamFormSkeleton />}>
        <NewTeamForm />
      </Suspense>
    </>
  );
}

async function NewTeamForm() {
  let agents;
  try {
    agents = await listAgentsForOwner();
  } catch (error) {
    unstable_rethrow(error);
    return <LoadError error={error} />;
  }
  return <TeamForm mode="create" agents={agents.map(({ id, name, role, enabled }) => ({ id, name, role, enabled }))} />;
}
