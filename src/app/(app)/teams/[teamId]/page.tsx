import type { Metadata } from "next";
import { Suspense } from "react";
import { AgentDetailsSkeleton } from "@/components/agents/agent-skeletons";
import { BackLink } from "@/components/agents/back-link";
import { LoadError } from "@/components/load-error";
import { TeamDetail } from "@/components/teams/team-detail";
import { loadTeam } from "./load-team";

export const metadata: Metadata = {
  title: "Team",
};

export default function TeamPage({ params }: PageProps<"/teams/[teamId]">) {
  return (
    <>
      <BackLink href="/teams">Teams</BackLink>
      <Suspense fallback={<AgentDetailsSkeleton />}>
        <TeamContent params={params} />
      </Suspense>
    </>
  );
}

async function TeamContent({ params }: Pick<PageProps<"/teams/[teamId]">, "params">) {
  const { teamId } = await params;
  const result = await loadTeam(teamId);
  if ("error" in result) return <LoadError error={result.error} subject="teams" />;
  return <TeamDetail detail={result.detail} />;
}
