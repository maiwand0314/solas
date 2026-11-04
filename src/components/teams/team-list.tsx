"use client";

import Link from "next/link";
import { useState } from "react";
import { SearchIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RelativeTime } from "@/components/ui/relative-time";
import { Select } from "@/components/ui/select";
import type { TeamSummary } from "@/server/teams/service";

/**
 * The searchable list of teams. One owner has a handful of teams, so search
 * and the agent filter run here, instantly, on what the server loaded.
 */
export function TeamList({ teams, agents }: { teams: TeamSummary[]; agents: { id: string; name: string }[] }) {
  const [query, setQuery] = useState("");
  const [agentId, setAgentId] = useState("");

  const needle = query.trim().toLowerCase();
  const visible = teams.filter(
    (team) =>
      (!agentId || team.members.some((member) => member.id === agentId)) &&
      (!needle ||
        [team.name, team.description, ...team.members.map((member) => member.name)].some((text) =>
          text.toLowerCase().includes(needle),
        )),
  );
  const filtered = Boolean(needle || agentId);

  return (
    <section aria-label="Teams">
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-xs">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle" />
          <Input
            type="search"
            aria-label="Search teams"
            placeholder="Search teams"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="pl-8"
          />
        </div>
        <div className="w-full sm:w-56">
          <Select aria-label="Filter by agent" value={agentId} onChange={(event) => setAgentId(event.target.value)}>
            <option value="">Any agent</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                With {agent.name}
              </option>
            ))}
          </Select>
        </div>
        <p aria-live="polite" className="text-sm text-subtle tabular-nums sm:ml-auto">
          {filtered ? `${visible.length} of ${teams.length}` : teams.length} {teams.length === 1 ? "team" : "teams"}
        </p>
      </div>

      {visible.length > 0 ? (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
          {visible.map((team) => (
            <li key={team.id} className="relative flex items-start gap-3 px-4 py-3.5 transition-colors duration-100 hover:bg-surface-hover/60">
              <div className="min-w-0 flex-1">
                <Link
                  href={`/teams/${team.id}`}
                  className="block truncate font-medium text-foreground after:absolute after:inset-0 after:content-['']"
                >
                  {team.name}
                </Link>
                {team.description && <p className="mt-0.5 line-clamp-2 text-sm text-muted md:line-clamp-1">{team.description}</p>}
                <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-subtle">
                  <span>{team.coordinator ? `Coordinator: ${team.coordinator.name}` : "No coordinator"}</span>
                  <span className="tabular-nums">
                    {team.members.length} {team.members.length === 1 ? "member" : "members"}
                  </span>
                  <span className="tabular-nums">
                    {team.taskCount} {team.taskCount === 1 ? "task" : "tasks"}
                  </span>
                  <span className="whitespace-nowrap">
                    Updated <RelativeTime date={team.updatedAt} />
                  </span>
                </p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="rounded-lg border border-dashed border-border-strong px-6 py-12 text-center">
          <p className="font-medium">No teams match</p>
          <p className="mt-1 text-sm text-muted">Search looks at team names, descriptions, and member names.</p>
          <Button
            size="sm"
            className="mt-4"
            onClick={() => {
              setQuery("");
              setAgentId("");
            }}
          >
            Clear filters
          </Button>
        </div>
      )}
    </section>
  );
}
